package com.efficiencyx.junos.inference

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RawTurnParserTest {
    private fun run(chunks: List<String>): Pair<List<TurnEvent>, Boolean> {
        val parser = RawTurnParser()
        val events = chunks.flatMap { parser.push(it) } + parser.finish()
        return events to parser.stopped
    }

    private fun text(events: List<TurnEvent>) = events.filterIsInstance<TurnEvent.Text>().joinToString("") { it.text }
    private fun thought(events: List<TurnEvent>) = events.filterIsInstance<TurnEvent.Thought>().joinToString("") { it.text }

    // captured off the phone, 2026-10-26
    private val witchHat = "<|channel>thought\nAnon asked me to put on my witch hat.\nTool check: change_outfit.\n<channel|>" +
        "<|tool_call>call:change_outfit{put_on:[<|\"|>witch_hat<|\"|>]}<tool_call|><|tool_response>"

    @Test
    fun splitsThoughtCallAndStop() {
        val (events, stopped) = run(listOf(witchHat))

        assertEquals("Anon asked me to put on my witch hat.\nTool check: change_outfit.\n", thought(events))
        assertEquals("", text(events))
        val call = events.filterIsInstance<TurnEvent.Call>().single().call
        assertEquals("change_outfit", call.name)
        assertEquals(JsonArray(listOf(JsonPrimitive("witch_hat"))), call.args["put_on"])
        assertTrue(stopped)
    }

    @Test
    fun sameResultOneCharAtATime() {
        val whole = run(listOf(witchHat))
        val split = run(witchHat.map { it.toString() })

        assertEquals(thought(whole.first), thought(split.first))
        assertEquals(whole.first.filterIsInstance<TurnEvent.Call>(), split.first.filterIsInstance<TurnEvent.Call>())
    }

    @Test
    fun plainReplyKeepsAngleBrackets() {
        val (events, stopped) = run(listOf("[A:emote|happy] 3 < 5, and <b>", " that's fine<turn|>ignored"))

        assertEquals("[A:emote|happy] 3 < 5, and <b> that's fine", text(events))
        assertTrue(stopped)
    }

    @Test
    fun unfinishedCallIsDropped() {
        val (events, _) = run(listOf("ok <|tool_call>call:change_outfit{put_on:[<|\"|>wit"))

        assertEquals("ok ", text(events))
        assertTrue(events.none { it is TurnEvent.Call })
    }

    @Test
    fun parsesNestedArgs() {
        val call = parseFcCall("call:search_lore{query:<|\"|>the facility, west wing<|\"|>,limit:3,exact:false,extra:{a:1.5}}")!!

        assertEquals("search_lore", call.name)
        assertEquals(buildJsonObject {
            put("query", "the facility, west wing"); put("limit", 3); put("exact", false)
            put("extra", buildJsonObject { put("a", 1.5) })
        }, call.args)
    }

    @Test
    fun rejectsGarbage() {
        assertNull(parseFcCall("call:broken{query:"))
        assertNull(parseFcCall("no braces here"))
    }

    @Test
    fun prefillPiecesCutBeforeTurns() {
        val turn = "<|turn>user\n" + "a".repeat(1200) + "<turn|>\n"
        val text = turn.repeat(5)
        val pieces = prefillPieces(text)

        assertEquals(text, pieces.joinToString(""))
        assertTrue(pieces.all { it.length <= 3000 })
        assertTrue(pieces.drop(1).all { it.startsWith("<|turn>") })
    }

    @Test
    fun prefillPiecesFallBackToNewlines() {
        val text = ("b".repeat(999) + "\n").repeat(7)
        val pieces = prefillPieces(text)

        assertEquals(text, pieces.joinToString(""))
        assertTrue(pieces.all { it.length <= 3000 && it.endsWith("\n") })
    }

    @Test
    fun blockCutMovesInWholeBlocks() {
        assertEquals(0, blockCut(-5, 40))
        assertEquals(0, blockCut(0, 40))
        assertEquals(40, blockCut(1, 40))
        assertEquals(40, blockCut(40, 40))
        assertEquals(80, blockCut(41, 40))
    }
}
