package com.efficiencyx.junos.away

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AwayTextsTest {
    @Test
    fun parsesAFencedArrayAndCapsTheCount() {
        val content = "Sure.\n```json\n[\"hey\", \"  where   are you \", \"\", 3, \"third\"]\n```"
        assertEquals(listOf("hey", "where are you"), AwayTexts.parseLines(content, 2))
    }

    @Test
    fun anythingUnreadableIsNoTexts() {
        assertTrue(AwayTexts.parseLines("I can't do that", 3).isEmpty())
        assertTrue(AwayTexts.parseLines("[\"open", 3).isEmpty())
    }

    @Test
    fun schedulesEachTextFromTheMomentHeLeft() {
        val plan = AwayTexts.schedule(1000, mapOf("missed" to listOf("a", "b"), "panicked" to listOf("c")))
        assertEquals(
            listOf(AwayText("missed:0", 8200, "a"), AwayText("missed:1", 8460, "b"), AwayText("panicked:0", 87400, "c")),
            plan,
        )
    }

    @Test
    fun everyTierHasAFallback() {
        for (spec in AwayTexts.MILESTONES) {
            val texts = AwayTexts.fallback(spec.tier, -7)
            assertTrue(spec.tier, texts.isNotEmpty() && texts.size <= spec.texts)
        }
    }

    @Test
    fun appliesTheNamesThePageHandedOver() {
        assertEquals("Where did you get to, Sam?", AwayTexts.applyNames("Where did you get to, {f_playerName}?", "Sam", "Jun"))
        assertEquals("Mei misses Sam.", AwayTexts.applyNames("Jun misses Anon.", "Sam", "Mei"))
        assertEquals("Junior stays", AwayTexts.applyNames("Junior stays", "Sam", "Mei"))
    }
}
