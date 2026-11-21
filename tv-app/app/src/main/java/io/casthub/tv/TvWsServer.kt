package io.casthub.tv

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * 电视端 WS 服务端（端口 9417）。
 * Java-WebSocket 回调运行在独立线程，所有播放器操作经 Handler post 回主线程。
 */
class TvWsServer(
    private val context: Context,
    private val token: String,
    private val onServerState: (Boolean, String) -> Unit = { _, _ -> }
) {
    interface PlayerController {
        fun pause()
        fun resume()
        fun stop()
        fun seekTo(positionMs: Long)
        fun statusJson(): String
    }

    private data class AuthFailure(var count: Int, var windowStart: Long)

    companion object {
        private const val TAG = "TvWsServer"
        const val PORT = 9417
        private const val MAX_AUTH_FAILURES = 10
        private const val AUTH_BLOCK_MS = 60_000L
        private const val MAX_MESSAGE_CHARS = 64 * 1024
        private const val MAX_CONNECTIONS = 32
        private const val CONNECTION_LOST_TIMEOUT_SECONDS = 30

        @Volatile
        var instance: TvWsServer? = null
            private set
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val authState = ConcurrentHashMap<WebSocket, Boolean>()
    private val connections = Collections.newSetFromMap(ConcurrentHashMap<WebSocket, Boolean>())
    private val authFailures = ConcurrentHashMap<String, AuthFailure>()
    private val challengeNonces = ConcurrentHashMap<WebSocket, String>()
    private val secureRandom = SecureRandom()
    private var server: InnerServer? = null
    private var controller: PlayerController? = null

    fun start() {
        if (server != null) return
        instance = this
        try {
            val inner = InnerServer(InetSocketAddress(PORT))
            server = inner
            inner.start()
        } catch (error: Exception) {
            Log.e(TAG, "WS 服务启动失败", error)
            onServerState(false, error.message ?: "启动失败")
        }
    }

    fun stop() {
        val inner = server
        server = null
        connections.clear()
        authState.clear()
        authFailures.clear()
        challengeNonces.clear()
        if (inner != null) {
            try {
                inner.stop(1000)
            } catch (error: Exception) {
                Log.w(TAG, "WS 服务停止异常", error)
            }
        }
        if (instance === this) instance = null
    }

    fun attachController(playerController: PlayerController?) {
        controller = playerController
    }

    fun sendStatus(json: String) {
        // 仅向已完成 hello 认证的连接发送播放状态，避免未配对连接窥探媒体信息。
        for ((conn, authenticated) in authState) {
            if (authenticated == true && conn.isOpen) {
                try {
                    sendSafe(conn, json)
                } catch (error: Exception) {
                    Log.w(TAG, "发送状态失败: ${error.message}")
                }
            }
        }
    }

    private fun sendSafe(conn: WebSocket, payload: String) {
        if (!conn.isOpen) return
        try {
            conn.send(payload)
        } catch (error: Exception) {
            Log.w(TAG, "发送消息失败: ${error.message}")
        }
    }

    private fun remoteKey(conn: WebSocket): String =
        conn.remoteSocketAddress?.address?.hostAddress ?: "unknown"

    private fun isAuthBlocked(key: String): Boolean {
        val failure = authFailures[key] ?: return false
        synchronized(failure) {
            if (System.currentTimeMillis() - failure.windowStart > AUTH_BLOCK_MS) {
                authFailures.remove(key)
                return false
            }
            return failure.count >= MAX_AUTH_FAILURES
        }
    }

    private fun recordAuthFailure(key: String) {
        val now = System.currentTimeMillis()
        val failure = authFailures[key] ?: AuthFailure(0, now).also { authFailures[key] = it }
        synchronized(failure) {
            if (now - failure.windowStart > AUTH_BLOCK_MS) {
                failure.count = 0
                failure.windowStart = now
            }
            failure.count += 1
        }
    }

    private inner class InnerServer(address: InetSocketAddress) : WebSocketServer(address) {
        override fun onStart() {
            Log.i(TAG, "WS_LISTENING ws://0.0.0.0:$PORT")
            setConnectionLostTimeout(CONNECTION_LOST_TIMEOUT_SECONDS)
            mainHandler.post { onServerState(true, "ws://0.0.0.0:$PORT") }
        }

        override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
            connections.add(conn)
            if (connections.size > MAX_CONNECTIONS) {
                Log.w(TAG, "连接数超过上限，拒绝 ${conn.remoteSocketAddress}")
                conn.close(1013, "too many connections")
                return
            }
            Log.i(TAG, "客户端接入: ${conn.remoteSocketAddress}")
            val nonceBytes = ByteArray(16)
            secureRandom.nextBytes(nonceBytes)
            val nonce = Base64.encodeToString(nonceBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            challengeNonces[conn] = nonce
            sendSafe(conn, Protocol.challenge(nonce))
        }

        override fun onMessage(conn: WebSocket, message: String?) {
            if (message == null) return
            if (message.length > MAX_MESSAGE_CHARS) {
                conn.close(4002, "message too large")
                return
            }
            val json = Protocol.parse(message)
            if (json == null) {
                sendSafe(conn, Protocol.error("BAD_MESSAGE", "非法 JSON 消息"))
                return
            }
            val type = json.optString("type", "")

            if (type == Protocol.TYPE_HELLO) {
                val key = remoteKey(conn)
                if (isAuthBlocked(key)) {
                    Log.w(TAG, "配对失败次数过多，暂时拒绝 $key")
                    conn.close(4003, "too many attempts")
                    return
                }
                val incomingVersion = if (json.has("version")) json.optInt("version", -1) else Protocol.PROTOCOL_VERSION
                if (incomingVersion != Protocol.PROTOCOL_VERSION) {
                    Log.w(TAG, "协议版本不兼容: $incomingVersion")
                    sendSafe(conn, Protocol.error("VERSION_UNSUPPORTED", "协议版本不兼容"))
                    conn.close(4004, "protocol version unsupported")
                    return
                }
                val clientId = json.optString("clientId", "")
                val proof = json.optString("proof", "")
                val nonce = challengeNonces.remove(conn)
                val incomingToken = json.optString("token", "")
                val authenticated = when {
                    proof.isNotEmpty() && !nonce.isNullOrEmpty() -> {
                        val expected = deriveProof(token, nonce, clientId)
                        MessageDigest.isEqual(expected.toByteArray(Charsets.UTF_8), proof.toByteArray(Charsets.UTF_8))
                    }
                    incomingToken.isNotEmpty() -> MessageDigest.isEqual(
                        incomingToken.toByteArray(Charsets.UTF_8),
                        token.toByteArray(Charsets.UTF_8)
                    )
                    else -> false
                }
                if (!authenticated) {
                    recordAuthFailure(key)
                    Log.w(TAG, "配对码错误，断开连接")
                    authState.remove(conn)
                    conn.close(4001, "invalid token")
                    return
                }
                authFailures.remove(key)
                authState[conn] = true
                Log.i(TAG, "配对成功 clientId=$clientId")
                sendSafe(conn, Protocol.helloAck("${Build.MANUFACTURER} ${Build.MODEL}"))
                return
            }

            if (authState[conn] != true) {
                conn.close(4001, "hello required")
                return
            }

            when (type) {
                Protocol.TYPE_PLAY -> {
                    val command = PlayCommand(
                        json.optString("url", ""),
                        json.optString("title", ""),
                        json.optString("mimeType", "")
                    )
                    if (!command.url.startsWith("http://") && !command.url.startsWith("https://")) {
                        sendSafe(conn, Protocol.error("BAD_URL", "只允许 http/https 媒体地址"))
                        return
                    }
                    if (command.title.length > 512 || command.mimeType.length > 128) {
                        sendSafe(conn, Protocol.error("BAD_MESSAGE", "播放参数过长"))
                        return
                    }
                    mainHandler.post {
                        PlayerActivity.launch(context, command.url, command.title, command.mimeType)
                    }
                }
                Protocol.TYPE_PAUSE -> mainHandler.post { controller?.pause() }
                Protocol.TYPE_RESUME -> mainHandler.post { controller?.resume() }
                Protocol.TYPE_STOP -> mainHandler.post { controller?.stop() }
                Protocol.TYPE_SEEK -> {
                    val position = json.optLong("positionMs", 0L)
                    mainHandler.post { controller?.seekTo(position) }
                }
                Protocol.TYPE_GET_STATUS -> mainHandler.post {
                    sendSafe(conn, controller?.statusJson() ?: Protocol.status("idle", 0L, 0L))
                }
                else -> sendSafe(conn, Protocol.error("UNKNOWN_TYPE", "未知消息类型: $type"))
            }
        }

        override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
            authState.remove(conn)
            challengeNonces.remove(conn)
            connections.remove(conn)
            Log.i(TAG, "连接关闭 code=$code reason=$reason")
        }

        /** PBKDF2-HMAC-SHA1 迭代 10 万次，和中枢 devices.ts 保持一致。 */
        private fun deriveProof(pairingToken: String, nonce: String, clientId: String): String {
            val salt = (nonce + ":" + clientId + ":" + Protocol.PROTOCOL_VERSION).toByteArray(Charsets.UTF_8)
            val spec = PBEKeySpec(pairingToken.toCharArray(), salt, 100_000, 256)
            val encoded = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(spec).encoded
            return Base64.encodeToString(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }

        override fun onError(conn: WebSocket?, ex: Exception?) {
            Log.e(TAG, "WS 错误: ${ex?.message}")
            if (conn == null) {
                // 异步 bind 失败不会抛到 start()，必须主动回传 UI。
                mainHandler.post { onServerState(false, ex?.message ?: "WS 服务错误") }
            }
        }
    }
}
