package io.casthub.tv

import org.json.JSONObject

/** 协议常量与消息构造/解析（与 PROTOCOL.md 一一对应）。 */
object Protocol {
    const val TYPE_HELLO = "hello"
    const val TYPE_HELLO_ACK = "helloAck"
    const val TYPE_PLAY = "play"
    const val TYPE_PAUSE = "pause"
    const val TYPE_RESUME = "resume"
    const val TYPE_STOP = "stop"
    const val TYPE_SEEK = "seek"
    const val TYPE_GET_STATUS = "getStatus"
    const val TYPE_STATUS = "status"
    const val TYPE_ERROR = "error"

    fun helloAck(deviceName: String): String = JSONObject().apply {
        put("type", TYPE_HELLO_ACK)
        put("ok", true)
        put("deviceName", deviceName)
    }.toString()

    fun status(state: String, positionMs: Long, durationMs: Long): String = JSONObject().apply {
        put("type", TYPE_STATUS)
        put("state", state)
        put("positionMs", positionMs)
        put("durationMs", durationMs)
    }.toString()

    fun error(code: String, message: String): String = JSONObject().apply {
        put("type", TYPE_ERROR)
        put("code", code)
        put("message", message)
    }.toString()

    fun parse(raw: String): JSONObject? = try {
        JSONObject(raw)
    } catch (_: Exception) {
        null
    }
}

/** 中枢下发的一条播放指令。 */
data class PlayCommand(
    val url: String,
    val title: String,
    val mimeType: String
)
