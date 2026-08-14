package com.efficiencyx.junos.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ChatRequestTest {
    private fun request(audio: String? = null, messages: List<ClientMessage> = listOf(ClientMessage("user", "hey"))) =
        ChatRequest(messages = messages, conversationId = 1, audio = audio)

    @Test
    fun refusesAudioTurns() {
        val error = assertThrows(IllegalStateException::class.java) { request(audio = "UklGRiQAAABXQVZF").validate() }

        assertEquals("audio_unsupported", error.message)
    }

    @Test
    fun acceptsOrdinaryTurns() {
        request().validate()
    }

    @Test
    fun rejectsUnknownRoles() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            request(messages = listOf(ClientMessage("tool", "result"))).validate()
        }

        assertEquals("invalid_request", error.message)
    }
}
