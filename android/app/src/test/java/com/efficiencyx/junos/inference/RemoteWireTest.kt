package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RemoteWireTest {
    private val call = ParsedToolCall("search_lore", Json.parseToJsonElement("""{"query":"Jun"}""").jsonObject)
    private val transcript = listOf(
        ChatMessage("system", "sys"),
        ChatMessage("user", "hi"),
        ChatMessage("assistant", "Let me check.", toolCalls = listOf(call)),
        ChatMessage("tool", "[\"fact\"]", toolName = "search_lore"),
    )

    private fun request(api: String, think: Boolean) = RemoteWire.request(
        api, "jun", transcript, ChatEngine.TOOL_SCHEMAS, think, 1024, 0.4f, "med", 12288,
    )

    @Test
    fun openAiShapeCarriesCallIdsAndStringArguments() {
        val messages = request("openai", true)["messages"]!!.jsonArray
        val assistant = messages[2].jsonObject
        val toolCall = assistant["tool_calls"]!!.jsonArray[0].jsonObject
        val tool = messages[3].jsonObject

        assertEquals("call_0", toolCall["id"]!!.jsonPrimitive.content)
        assertEquals("""{"query":"Jun"}""", toolCall["function"]!!.jsonObject["arguments"]!!.jsonPrimitive.content)
        assertEquals("call_0", tool["tool_call_id"]!!.jsonPrimitive.content)
        assertEquals("search_lore", tool["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun ollamaShapeKeepsObjectArgumentsAndLeavesThinkOutWhenThinking() {
        val thinking = request("ollama", true)
        val plain = request("ollama", false)
        val toolCall = thinking["messages"]!!.jsonArray[2].jsonObject["tool_calls"]!!.jsonArray[0].jsonObject

        assertTrue(toolCall["function"]!!.jsonObject["arguments"] is JsonObject)
        assertFalse("id" in toolCall)
        assertFalse("think" in thinking)
        assertFalse(plain["think"]!!.jsonPrimitive.boolean)
        assertEquals("medium", thinking["options"]!!.jsonObject["reasoning_effort"]!!.jsonPrimitive.content)
        assertEquals(12288, thinking["options"]!!.jsonObject["num_ctx"]!!.jsonPrimitive.int)
    }

    @Test
    fun junShapeLeavesModelAndSamplingToTheDesktop() {
        val body = request("jun", false)

        assertNull(body["model"])
        assertNull(body["temperature"])
        assertEquals("medium", body["reasoning"]!!.jsonPrimitive.content)
        assertEquals(ChatEngine.TOOL_SCHEMAS.size, body["tools"]!!.jsonArray.size)
        assertEquals("function", body["tools"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun sseStreamGluesToolCallFragments() {
        val parser = StreamParser(ollama = false)
        val events = listOf(
            """data: {"choices":[{"index":0,"delta":{"reasoning_content":"hmm"}}]}""",
            """data: {"choices":[{"index":0,"delta":{"content":"Let me check. "}}]}""",
            """data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"abc","function":{"name":"search_lore","arguments":"{\"query\":"}}]}}]}""",
            """data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Jun\"}"}}]}}]}""",
            """data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":3},"model":"jun-local"}""",
            "",
            "data: [DONE]",
        ).flatMap(parser::line) + parser.finish()

        assertEquals(TurnEvent.Thought("hmm"), events[0])
        assertEquals(TurnEvent.Text("Let me check. "), events[1])
        assertEquals(TurnEvent.Call(call), events[2])
        assertEquals(3, events.size)
        assertEquals(50, parser.stats(10)["prompt_eval_count"]!!.jsonPrimitive.int)
        assertEquals(JsonPrimitive("jun-local"), parser.stats(10)["model"])
    }

    @Test
    fun ndjsonStreamReadsOllama() {
        val parser = StreamParser(ollama = true)
        val events = listOf(
            """{"message":{"thinking":"hmm"}}""",
            """{"message":{"content":"Hello"}}""",
            """{"message":{"tool_calls":[{"function":{"name":"search_lore","arguments":{"query":"Jun"}}}]}}""",
            """{"done":true,"eval_count":7,"prompt_eval_count":42,"model":"jun:test"}""",
        ).flatMap(parser::line) + parser.finish()

        assertEquals(listOf(TurnEvent.Thought("hmm"), TurnEvent.Text("Hello"), TurnEvent.Call(call)), events)
        assertEquals(7, parser.stats(10)["eval_count"]!!.jsonPrimitive.int)
    }

    @Test
    fun anErrorFrameStopsTheTurn() {
        for ((ollama, line) in listOf(
            false to """data: {"error":{"message":"upstream_unavailable"}}""",
            true to """{"error":"model not found"}""",
        )) {
            try {
                StreamParser(ollama).line(line)
                fail("no error from $line")
            } catch (error: RemoteError) {
                assertTrue(error.code.isNotEmpty())
            }
        }
    }

    @Test
    fun probeReadsTheWindow() {
        assertEquals(16384, Json.parseToJsonElement("""{"model":"x","ctx":16384}""").ctxFromProbe("jun"))
        assertEquals(8192, Json.parseToJsonElement("""{"data":[{"id":"jun","max_model_len":8192}]}""").ctxFromProbe("openai"))
        assertNull(Json.parseToJsonElement("""{"models":[]}""").ctxFromProbe("ollama"))
    }
}
