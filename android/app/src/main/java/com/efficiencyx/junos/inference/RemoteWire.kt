package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

class RemoteError(val code: String, cause: Throwable? = null) : Exception(code, cause)

// "jun" is the desktop's api/model.php: openai-shaped, but php picks
// the model and the sampling, same as for her chat page
internal object RemoteWire {
    fun chatUrl(api: String, base: String): String = when (api) {
        "openai" -> base.trimEnd('/') + "/v1/chat/completions"
        "ollama" -> base.trimEnd('/') + "/api/chat"
        else -> base
    }

    fun probeUrl(api: String, base: String): String = when (api) {
        "openai" -> base.trimEnd('/') + "/v1/models"
        "ollama" -> base.trimEnd('/') + "/api/tags"
        else -> base
    }

    fun request(
        api: String,
        model: String?,
        messages: List<ChatMessage>,
        tools: List<String>,
        think: Boolean,
        maxTokens: Int,
        temperature: Float,
        reasoning: String,
        contextTokens: Int,
    ): JsonObject {
        // the trace marker says "med", every server API says "medium"
        val effort = if (reasoning == "med") "medium" else reasoning
        val toolArray = JsonArray(tools.map { Json.parseToJsonElement(it) })
        return buildJsonObject {
            put("messages", messages(api, messages))
            if (tools.isNotEmpty()) put("tools", toolArray)
            when (api) {
                "jun" -> {
                    put("think", think)
                    put("reasoning", effort)
                    put("max_tokens", maxTokens)
                }
                "ollama" -> {
                    put("model", model)
                    put("stream", true)
                    put("keep_alive", -1)
                    put("options", buildJsonObject {
                        put("reasoning_effort", effort)
                        put("temperature", temperature)
                        put("top_p", 0.95); put("top_k", 80); put("min_p", 0.01)
                        put("num_ctx", contextTokens)
                        put("num_predict", maxTokens)
                    })
                    // asking for thinking means LEAVING think out. think:true
                    // trips a capability check her GGUFs fail, ollama 400s
                    if (!think) put("think", false)
                }
                else -> {
                    put("model", model)
                    put("stream", true)
                    put("temperature", temperature)
                    put("top_p", 0.95); put("top_k", 80); put("min_p", 0.01)
                    put("max_tokens", maxTokens)
                    put("chat_template_kwargs", buildJsonObject { put("enable_thinking", think) })
                    put("stream_options", buildJsonObject { put("include_usage", true) })
                }
            }
        }
    }

    // ChatMessage carries no call ids, so they're handed out here in
    // order and the tool turns that follow take them back in order
    fun messages(api: String, messages: List<ChatMessage>): JsonArray {
        val ollama = api == "ollama"
        val pending = ArrayDeque<String>()
        var next = 0
        return buildJsonArray {
            for (message in messages) add(buildJsonObject {
                put("role", message.role)
                put("content", message.content)
                if (message.role == "assistant" && message.toolCalls.isNotEmpty()) {
                    put("tool_calls", buildJsonArray {
                        for (call in message.toolCalls) add(buildJsonObject {
                            val id = "call_${next++}"
                            pending.addLast(id)
                            if (!ollama) {
                                put("id", id)
                                put("type", "function")
                            }
                            put("function", buildJsonObject {
                                put("name", call.name)
                                if (ollama) put("arguments", call.args) else put("arguments", call.args.toString())
                            })
                        })
                    })
                }
                if (message.role == "tool") {
                    put("tool_call_id", pending.removeFirstOrNull() ?: "call_${next++}")
                    put("name", message.toolName ?: "unknown")
                }
            })
        }
    }
}

// SSE for jun/openai, NDJSON for ollama. openai sends a tool call in
// fragments, so calls only come out at finish()
internal class StreamParser(private val ollama: Boolean) {
    private val json = Json { ignoreUnknownKeys = true }
    private val fragments = sortedMapOf<Int, Array<StringBuilder>>()
    var promptTokens = 0
        private set
    var evalTokens = 0
        private set
    var model: String? = null
        private set

    fun line(raw: String): List<TurnEvent> {
        val line = raw.trim()
        val payload = if (ollama) line else line.removePrefix("data:").trim().takeIf { line.startsWith("data:") }
        if (payload.isNullOrEmpty() || payload == "[DONE]") return emptyList()
        val obj = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return emptyList()
        obj["error"]?.let { error ->
            val message = (error as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
                ?: (error as? JsonPrimitive)?.contentOrNull ?: "upstream_error"
            throw RemoteError(message)
        }
        return if (ollama) ollamaLine(obj) else openAiLine(obj)
    }

    fun finish(): List<TurnEvent> = fragments.values.mapNotNull { (_, name, args) ->
        if (name.isEmpty()) null else TurnEvent.Call(ParsedToolCall(name.toString(), parseArgs(args.toString())))
    }.also { fragments.clear() }

    private fun ollamaLine(obj: JsonObject): List<TurnEvent> {
        val out = mutableListOf<TurnEvent>()
        val message = obj["message"] as? JsonObject
        message?.get("thinking")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { out += TurnEvent.Thought(it) }
        message?.get("content")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { out += TurnEvent.Text(it) }
        (message?.get("tool_calls") as? JsonArray)?.forEach { call ->
            val function = (call as? JsonObject)?.get("function") as? JsonObject ?: return@forEach
            val name = function["name"]?.jsonPrimitive?.contentOrNull ?: return@forEach
            val args = when (val raw = function["arguments"]) {
                is JsonObject -> raw
                is JsonPrimitive -> parseArgs(raw.content)
                else -> JsonObject(emptyMap())
            }
            out += TurnEvent.Call(ParsedToolCall(name, args))
        }
        if (obj["done"]?.jsonPrimitive?.contentOrNull == "true") {
            promptTokens = obj["prompt_eval_count"]?.jsonPrimitive?.intOrNull ?: promptTokens
            evalTokens = obj["eval_count"]?.jsonPrimitive?.intOrNull ?: evalTokens
            model = obj["model"]?.jsonPrimitive?.contentOrNull ?: model
        }
        return out
    }

    private fun openAiLine(obj: JsonObject): List<TurnEvent> {
        (obj["usage"] as? JsonObject)?.let { usage ->
            promptTokens = usage["prompt_tokens"]?.jsonPrimitive?.intOrNull ?: promptTokens
            evalTokens = usage["completion_tokens"]?.jsonPrimitive?.intOrNull ?: evalTokens
        }
        obj["model"]?.jsonPrimitive?.contentOrNull?.let { model = it }
        val delta = ((obj["choices"] as? JsonArray)?.firstOrNull() as? JsonObject)?.get("delta") as? JsonObject
            ?: return emptyList()
        val out = mutableListOf<TurnEvent>()
        val thought = (delta["reasoning_content"] ?: delta["reasoning"]) as? JsonPrimitive
        thought?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { out += TurnEvent.Thought(it) }
        (delta["content"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { out += TurnEvent.Text(it) }
        (delta["tool_calls"] as? JsonArray)?.forEach { fragment ->
            val call = fragment as? JsonObject ?: return@forEach
            val index = call["index"]?.jsonPrimitive?.intOrNull ?: 0
            val slot = fragments.getOrPut(index) { arrayOf(StringBuilder(), StringBuilder(), StringBuilder()) }
            call["id"]?.jsonPrimitive?.contentOrNull?.let { slot[0].setLength(0); slot[0].append(it) }
            val function = call["function"] as? JsonObject ?: return@forEach
            function["name"]?.jsonPrimitive?.contentOrNull?.let { slot[1].append(it) }
            function["arguments"]?.jsonPrimitive?.contentOrNull?.let { slot[2].append(it) }
        }
        return out
    }

    private fun parseArgs(raw: String): JsonObject =
        runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: JsonObject(emptyMap())

    fun stats(elapsedMs: Long): JsonObject = buildJsonObject {
        put("eval_count", evalTokens)
        put("eval_ms", elapsedMs)
        put("prompt_eval_count", promptTokens)
        model?.let { put("model", it) }
    }
}

internal fun JsonElement.ctxFromProbe(api: String): Int? = runCatching {
    when (api) {
        "jun" -> jsonObject["ctx"]?.jsonPrimitive?.intOrNull
        "openai" -> jsonObject["data"]?.jsonArray?.firstOrNull()?.jsonObject?.get("max_model_len")?.jsonPrimitive?.longOrNull?.toInt()
        else -> null
    }
}.getOrNull()?.takeIf { it > 0 }
