package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TripsTest {
    @Test
    fun everyTripToolIsDeclared() {
        val declared = ChatEngine.TOOL_SCHEMAS.map {
            Json.parseToJsonElement(it).jsonObject["function"]!!.jsonObject["name"]!!.jsonPrimitive.content
        }
        assertTrue(declared.containsAll(Trips.TOOLS.keys))
    }

    @Test
    fun guessesTypedInvites() {
        assertEquals("shop", Trips.guessInvite("Wanna go to Annalie's shop with me?", ""))
        assertEquals("cards", Trips.guessInvite("yeah sure", "Want to play some blackjack?"))
        assertEquals("", Trips.guessInvite("not the shop today", ""))
        assertEquals("", Trips.guessInvite("What is your favorite color?", ""))
    }

    @Test
    fun readsHerYes() {
        assertTrue(Trips.replyAccepts("Fine.\nI'll go."))
        assertTrue(Trips.replyAccepts("I'm going. [A:smile]"))
        assertTrue(Trips.replyAccepts("Okay, lead the way."))
        assertFalse(Trips.replyAccepts("I don't want to go to Annalie's shop right now. I'm not ready to leave."))
        assertFalse(Trips.replyAccepts("I'm going to stay right here."))
    }
}
