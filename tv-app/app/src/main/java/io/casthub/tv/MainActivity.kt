package io.casthub.tv

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import kotlin.random.Random

/** 配对屏：显示本机局域网 WS 地址与 6 位随机配对码。 */
class MainActivity : AppCompatActivity() {
    private lateinit var addressText: TextView
    private lateinit var codeText: TextView
    private lateinit var statusText: TextView
    private var pairingCode: String = ""
    private var wsServer: TvWsServer? = null

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
        addressText.text = "ws://${findLanIpv4()}:9417"
    }

    override fun onResume() {
        super.onResume()
        refreshAddress()
    }

    override fun onDestroy() {
        wsServer?.stop()
        wsServer = null
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_CODE, pairingCode)
    }

    private fun generatePairingCode(): String = (100000 + Random.nextInt(900000)).toString()

    /** 枚举本机局域网 IPv4（过滤回环与 IPv6），优先常见私网网段。 */
    private fun findLanIpv4(): String {
        val candidates = mutableListOf<String>()
        try {
            for (networkInterface in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!networkInterface.isUp || networkInterface.isLoopback) continue
                for (address in Collections.list(networkInterface.inetAddresses)) {
                    if (address is Inet4Address && !address.isLoopbackAddress && !address.isLinkLocalAddress) {
                        address.hostAddress?.let { candidates.add(it) }
                    }
                }
            }
        } catch (_: Exception) {
            // 忽略，使用默认值
        }
        return candidates.firstOrNull { it.startsWith("192.168.") }
            ?: candidates.firstOrNull { it.startsWith("10.") }
            ?: candidates.firstOrNull { it.startsWith("172.") }
            ?: candidates.firstOrNull()
            ?: "0.0.0.0"
    }

    companion object {
        private const val KEY_CODE = "pairing_code"
    }
}
