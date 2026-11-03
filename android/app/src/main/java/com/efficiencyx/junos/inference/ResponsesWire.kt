package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// the ChatGPT sign-in only opens the Codex backend, and that
// only speaks the Responses API, not chat completions
internal object ResponsesWire {
    const val URL = "https://chatgpt.com/backend-api/codex/responses"

    fun request(
        model: String?,
        messages: List<ChatMessage>,
        tools: List<String>,
        think: Boolean,
        reasoning: String,
    ): JsonObject {
        val effort = if (reasoning == "med") "medium" else reasoning
        return buildJsonObject {
            put("model", model)
            put("store", false)
            put("stream", true)
            put("instructions", messages.filter { it.role == "system" }.joinToString("\n\n") { it.content })
            put("input", input(messages))
            if (tools.isNotEmpty()) {
                put("tools", buildJsonArray { for (tool in tools) add(flatTool(tool)) })
                put("tool_choice", "auto")
                put("parallel_tool_calls", false)
            }
            put("reasoning", buildJsonObject {
                put("effort", if (think) effort else "low")
                if (think) put("summary", "auto")
            })
        }
    }

    // ChatMessage carries no call ids, same trick as RemoteWire.messages()
    fun input(messages: List<ChatMessage>): JsonArray {
        val pending = ArrayDeque<String>()
        var next = 0
        return buildJsonArray {
            for (message in messages) when (message.role) {
                "system" -> Unit
                "tool" -> add(buildJsonObject {
                    put("type", "function_call_output")
                    put("call_id", pending.removeFirstOrNull() ?: "call_${next++}")
                    put("output", message.content)
                })
                "assistant" -> {
                    if (message.content.isNotEmpty()) add(text("assistant", "output_text", message.content))
                    for (call in message.toolCalls) add(buildJsonObject {
                        val id = "call_${next++}"
                        pending.addLast(id)
                        put("type", "function_call")
                        put("call_id", id)
                        put("name", call.name)
                        put("arguments", call.args.toString())
                    })
                }
                else -> add(text("user", "input_text", message.content))
            }
        }
    }

    private fun text(role: String, type: String, value: String) = buildJsonObject {
        put("role", role)
        put("content", buildJsonArray { add(buildJsonObject { put("type", type); put("text", value) }) })
    }

    private fun flatTool(raw: String): JsonObject {
        val function = Json.parseToJsonElement(raw).jsonObject["function"]!!.jsonObject
        return buildJsonObject {
            put("type", "function")
            for ((key, value) in function) put(key, value)
        }
    }
}

internal class ResponsesParser : TurnParser {
    private val json = Json { ignoreUnknownKeys = true }
    private val calls = mutableListOf<TurnEvent>()
    private var promptTokens = 0
    private var evalTokens = 0
    private var model: String? = null

    override fun line(raw: String): List<TurnEvent> {
        val line = raw.trim()
        if (!line.startsWith("data:")) return emptyList()
        val payload = line.removePrefix("data:").trim()
        if (payload.isEmpty() || payload == "[DONE]") return emptyList()
        val obj = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return emptyList()
        val delta = { (obj["delta"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } }
        return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "response.output_text.delta" -> listOfNotNull(delta()?.let { TurnEvent.Text(it) })
            "response.reasoning_summary_text.delta" -> listOfNotNull(delta()?.let { TurnEvent.Thought(it) })
            "response.output_item.done" -> {
                val item = obj["item"] as? JsonObject
                if (item?.get("type")?.jsonPrimitive?.contentOrNull == "function_call") {
                    val name = item["name"]?.jsonPrimitive?.contentOrNull
                    val args = item["arguments"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    if (name != null) calls += TurnEvent.Call(ParsedToolCall(name, parseArgs(args)))
                }
                emptyList()
            }
            "response.completed" -> {
                val response = obj["response"] as? JsonObject
                val usage = response?.get("usage") as? JsonObject
                promptTokens = usage?.get("input_tokens")?.jsonPrimitive?.intOrNull ?: promptTokens
                evalTokens = usage?.get("output_tokens")?.jsonPrimitive?.intOrNull ?: evalTokens
                model = response?.get("model")?.jsonPrimitive?.contentOrNull ?: model
                emptyList()
            }
            "response.failed", "error" -> {
                val error = ((obj["response"] as? JsonObject)?.get("error") ?: obj["error"] ?: obj) as? JsonObject
                throw RemoteError(error?.get("message")?.jsonPrimitive?.contentOrNull ?: "upstream_error")
            }
            else -> emptyList()
        }
    }

    override fun finish(): List<TurnEvent> = calls.toList().also { calls.clear() }

    private fun parseArgs(raw: String): JsonObject =
        runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: JsonObject(emptyMap())

    override fun stats(elapsedMs: Long): JsonObject = buildJsonObject {
        put("eval_count", evalTokens)
        put("eval_ms", elapsedMs)
        put("prompt_eval_count", promptTokens)
        model?.let { put("model", it) }
    }
}
