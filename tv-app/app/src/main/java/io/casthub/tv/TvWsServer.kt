package io.casthub.tv

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap

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

    companion object {
        private const val TAG = "TvWsServer"
        const val PORT = 9417

        @Volatile
        var instance: TvWsServer? = null
            private set
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val authState = ConcurrentHashMap<WebSocket, Boolean>()
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
        server?.broadcast(json)
    }

    private inner class InnerServer(address: InetSocketAddress) : WebSocketServer(address) {
        override fun onStart() {
            Log.i(TAG, "WS_LISTENING ws://0.0.0.0:$PORT")
            mainHandler.post { onServerState(true, "ws://0.0.0.0:$PORT") }
        }

        override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
            Log.i(TAG, "客户端接入: ${conn.remoteSocketAddress}")
        }

        override fun onMessage(conn: WebSocket, message: String?) {
            if (message == null) return
            val json = Protocol.parse(message)
            if (json == null) {
                conn.send(Protocol.error("BAD_MESSAGE", "非法 JSON 消息"))
                return
            }
            val type = json.optString("type", "")

            if (type == Protocol.TYPE_HELLO) {
                val incomingToken = json.optString("token", "")
                if (incomingToken != token) {
                    Log.w(TAG, "配对码错误，断开连接")
                    authState.remove(conn)
                    conn.close(4001, "invalid token")
                    return
                }
                authState[conn] = true
                Log.i(TAG, "配对成功 clientId=${json.optString("clientId")}")
                conn.send(Protocol.helloAck("${Build.MANUFACTURER} ${Build.MODEL}"))
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
                    conn.send(controller?.statusJson() ?: Protocol.status("idle", 0L, 0L))
                }
                else -> conn.send(Protocol.error("UNKNOWN_TYPE", "未知消息类型: $type"))
            }
        }

        override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
            authState.remove(conn)
            Log.i(TAG, "连接关闭 code=$code reason=$reason")
        }

        override fun onError(conn: WebSocket?, ex: Exception?) {
            Log.e(TAG, "WS 错误: ${ex?.message}")
        }
    }
}
