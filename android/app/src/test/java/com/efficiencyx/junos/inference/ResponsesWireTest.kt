package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ResponsesWireTest {
    private val call = ParsedToolCall("search_lore", Json.parseToJsonElement("""{"query":"Jun"}""").jsonObject)
    private val transcript = listOf(
        ChatMessage("system", "sys"),
        ChatMessage("user", "hi"),
        ChatMessage("assistant", "", toolCalls = listOf(call)),
        ChatMessage("tool", "[\"fact\"]", toolName = "search_lore"),
    )

    @Test
    fun systemGoesToInstructionsAndCallsPairUp() {
        val body = ResponsesWire.request("gpt-test", transcript, ChatEngine.TOOL_SCHEMAS, true, "med")
        val input = body["input"]!!.jsonArray

        assertEquals("sys", body["instructions"]!!.jsonPrimitive.content)
        assertFalse(body["store"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(3, input.size)
        assertEquals("input_text", input[0].jsonObject["content"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("function_call", input[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("""{"query":"Jun"}""", input[1].jsonObject["arguments"]!!.jsonPrimitive.content)
        assertEquals(input[1].jsonObject["call_id"], input[2].jsonObject["call_id"])
        assertEquals("medium", body["reasoning"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        val tool = body["tools"]!!.jsonArray[0].jsonObject
        assertEquals("search_recent_chats", tool["name"]!!.jsonPrimitive.content)
        assertTrue("parameters" in tool)
    }

    @Test
    fun eventsBecomeTextThoughtsAndCalls() {
        val parser = ResponsesParser()
        val events = listOf(
            """event: response.reasoning_summary_text.delta""",
            """data: {"type":"response.reasoning_summary_text.delta","delta":"hmm"}""",
            """data: {"type":"response.output_text.delta","delta":"Let me check."}""",
            """data: {"type":"response.output_item.done","item":{"type":"function_call","name":"search_lore","arguments":"{\"query\":\"Jun\"}","call_id":"x"}}""",
            """data: {"type":"response.completed","response":{"model":"gpt-test","usage":{"input_tokens":40,"output_tokens":5}}}""",
        ).flatMap(parser::line) + parser.finish()

        assertEquals(listOf(TurnEvent.Thought("hmm"), TurnEvent.Text("Let me check."), TurnEvent.Call(call)), events)
        assertEquals(40, parser.stats(10)["prompt_eval_count"]!!.jsonPrimitive.int)
    }

    @Test
    fun aFailedResponseStopsTheTurn() {
        try {
            ResponsesParser().line("""data: {"type":"response.failed","response":{"error":{"message":"usage_limit_reached"}}}""")
            fail("no error")
        } catch (error: RemoteError) {
            assertEquals("usage_limit_reached", error.code)
        }
    }
}
