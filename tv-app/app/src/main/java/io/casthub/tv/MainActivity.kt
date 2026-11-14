package io.casthub.tv

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.Collections

/** 配对屏：显示本机局域网 WS 地址与 8 位安全随机配对码。 */
class MainActivity : AppCompatActivity() {
    private lateinit var addressText: TextView
    private lateinit var codeText: TextView
    private lateinit var statusText: TextView
    private var pairingCode: String = ""
    private var wsServer: TvWsServer? = null
    private val secureRandom = SecureRandom()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        addressText = findViewById(R.id.addressText)
        codeText = findViewById(R.id.codeText)
        statusText = findViewById(R.id.statusText)

        pairingCode = savedInstanceState?.getString(KEY_CODE) ?: generatePairingCode()
        startServer()

        findViewById<Button>(R.id.regenerateButton).setOnClickListener {
            wsServer?.stop()
            pairingCode = generatePairingCode()
            startServer()
        }
    }

    private fun startServer() {
        codeText.text = pairingCode
        statusText.text = "正在启动服务…"
        wsServer = TvWsServer(applicationContext, pairingCode) { ready, message ->
            runOnUiThread {
                statusText.text = if (ready) "等待控制台连接（端口 9417）" else "服务启动失败：$message"
            }
        }
        wsServer?.start()
        refreshAddress()
    }

    private fun refreshAddress() {
        val ip = findLanIpv4()
        addressText.text = if (ip == null) {
            "未找到局域网地址，请检查网络连接"
        } else {
            "ws://$ip:9417"
        }
    }

    override fun onResume() {
        super.onResume()
        refreshAddress()
    }

    override fun onDestroy() {
        // 始终停止旧实例，避免配置变更重建时新实例 bind 9417 发生 EADDRINUSE；
        // 配对码已通过 onSaveInstanceState 保留，重建后不会变化。
        wsServer?.stop()
        wsServer = null
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_CODE, pairingCode)
    }

    /** 8 位数字配对码，使用 SecureRandom，禁止可预测的伪随机序列。 */
    private fun generatePairingCode(): String = (secureRandom.nextInt(90_000_000) + 10_000_000).toString()

    /** 枚举本机局域网 IPv4（过滤回环、IPv6、虚拟网卡），优先常见私网网段。 */
    private fun findLanIpv4(): String? {
        val candidates = mutableListOf<Pair<Int, String>>()
        try {
            for (networkInterface in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!networkInterface.isUp || networkInterface.isLoopback || networkInterface.isVirtual) continue
                val lowerName = networkInterface.name.lowercase()
                if (Regex("^(p2p|dummy|rmnet|tun|tap|veth|docker|bridge)").containsMatchIn(lowerName)) continue
                for (address in Collections.list(networkInterface.inetAddresses)) {
                    if (address is Inet4Address && !address.isLoopbackAddress && !address.isLinkLocalAddress) {
                        val host = address.hostAddress ?: continue
                        val score = when {
                            host.startsWith("192.168.") -> 0
                            host.startsWith("10.") -> 1
                            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host) -> 2
                            else -> 10
                        }
                        val nameBonus = if (lowerName.startsWith("wlan") || lowerName.startsWith("eth")) -1 else 0
                        candidates.add((score + nameBonus) to host)
                    }
                }
            }
        } catch (_: Exception) {
            // 忽略，使用默认值
        }
        return candidates.minByOrNull { it.first }?.second
    }

    companion object {
        private const val KEY_CODE = "pairing_code"
    }
}
