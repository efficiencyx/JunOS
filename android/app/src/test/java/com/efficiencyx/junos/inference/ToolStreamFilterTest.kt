package com.efficiencyx.junos.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolStreamFilterTest {
    private fun run(vararg chunks: String): Pair<String, ToolStreamFilter> {
        val filter = ToolStreamFilter()
        val out = StringBuilder()
        chunks.forEach { chunk -> filter.push(chunk).forEach(out::append) }
        filter.finish().forEach(out::append)
        return out.toString() to filter
    }

    @Test
    fun keepsBracketsInsideJsonStrings() {
        val (visible, filter) = run("""hey [TOOL:search_lore|{"query":"the [vault] logs"}] ok""")

        assertEquals("hey  ok", visible)
        assertEquals(1, filter.calls.size)
        assertEquals("search_lore", filter.calls[0].name)
    }

    @Test
    fun toleratesWhitespaceAroundSeparators() {
        val (visible, filter) = run("""[TOOL: search_lore | {"query":"jun"} ]""")

        assertEquals("", visible)
        assertEquals("search_lore", filter.calls.single().name)
    }

    @Test
    fun dropsInvalidJsonInsteadOfEmittingIt() {
        val (visible, filter) = run("""before [TOOL:search_lore|{"query":}] after""")

        assertEquals("before  after", visible)
        assertTrue(filter.calls.isEmpty())
    }

    @Test
    fun dropsMarkerTruncatedMidStream() {
        val (visible, filter) = run("""said [TOOL:search_lore|{"query":"jun""")

        assertEquals("said ", visible)
        assertTrue(filter.calls.isEmpty())
    }

    @Test
    fun dropsOverlongMarker() {
        val (visible, filter) = run("[TOOL:search_lore|{\"query\":\"" + "x".repeat(9000) + "\"}]")

        assertEquals("", visible)
        assertTrue(filter.calls.isEmpty())
    }

    @Test
    fun passesActionTagsThroughUnmodified() {
        val text = "she smiles [A:emote|happy] and waits"
        val (visible, filter) = run(text)

        assertEquals(text, visible)
        assertTrue(filter.calls.isEmpty())
    }

    @Test
    fun handlesMarkerSplitAcrossChunks() {
        val (visible, filter) = run("hi [TO", "OL:memory", "_write|{\"memory\":\"a\"}", "] there")

        assertEquals("hi  there", visible)
        assertEquals("memory_write", filter.calls.single().name)
    }
}

class ThinkStreamFilterTest {
    private fun run(vararg chunks: String): String {
        val filter = ThinkStreamFilter()
        val out = StringBuilder()
        chunks.forEach { out.append(filter.push(it)) }
        out.append(filter.finish())
        return out.toString()
    }

    @Test
    fun stripsReasoningBlock() {
        assertEquals("hello there", run("hello <think>weighing it up</think>there"))
    }

    @Test
    fun stripsBlockArrivingAcrossTokens() {
        assertEquals("ab", run("a<th", "ink>hmm</thi", "nk>b"))
    }

    @Test
    fun leavesOrdinaryAngleBracketsAlone() {
        assertEquals("a < b <x> c", run("a < b <x> c"))
    }

    @Test
    fun dropsUnclosedReasoning() {
        assertEquals("a", run("a<think>still going"))
    }
}
