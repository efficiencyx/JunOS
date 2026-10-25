package com.efficiencyx.junos.inference

import org.junit.Assert.assertEquals
import org.junit.Test

class ThinkStreamFilterTest {
    private fun run(vararg chunks: String): Pair<String, String> {
        val filter = ThinkStreamFilter()
        val reply = StringBuilder()
        val thought = StringBuilder()
        for (chunk in chunks) {
            reply.append(filter.push(chunk))
            thought.append(filter.drainThought())
        }
        reply.append(filter.finish())
        thought.append(filter.drainThought())
        return reply.toString() to thought.toString()
    }

    @Test
    fun splitsThoughtFromReply() {
        assertEquals("hi" to "he said hi", run("<think>he said hi</think>hi"))
    }

    @Test
    fun handlesTagsSplitAcrossChunks() {
        assertEquals("hey <b>" to "a <x b", run("<thi", "nk>a <x", " b</th", "ink>hey <b>"))
    }

    @Test
    fun keepsUnclosedThought() {
        assertEquals("" to "cut off <", run("<think>cut off <"))
    }
}
