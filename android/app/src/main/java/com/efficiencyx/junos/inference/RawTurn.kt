package com.efficiencyx.junos.inference

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// a raw Session hands back gemma4's markers as plain text, the
// parsing Conversation does for us has to happen here instead
internal class RawTurnParser {
    private enum class Mode { TEXT, THOUGHT, CALL }

    private val pending = StringBuilder()
    private val call = StringBuilder()
    private var mode = Mode.TEXT
    private var label = false
    var stopped = false
        private set

    fun push(chunk: String): List<TurnEvent> {
        if (stopped) return emptyList()
        pending.append(chunk)
        val events = mutableListOf<TurnEvent>()
        while (!stopped) {
            if (label) {
                val newline = pending.indexOf("\n")
                if (newline < 0) break
                pending.delete(0, newline + 1)
                label = false
            }
            val markers = when (mode) {
                Mode.TEXT -> TEXT_MARKERS
                Mode.THOUGHT -> listOf(THOUGHT_CLOSE)
                Mode.CALL -> listOf(CALL_CLOSE)
            }
            val hit = markers.mapNotNull { m -> pending.indexOf(m).takeIf { it >= 0 }?.let { it to m } }.minByOrNull { it.first }
            if (hit == null) {
                val keep = heldTail(markers)
                take(pending.length - keep, events)
                break
            }
            val (at, marker) = hit
            take(at, events)
            pending.delete(0, marker.length)
            when (marker) {
                THOUGHT_OPEN -> { mode = Mode.THOUGHT; label = true }
                THOUGHT_CLOSE -> mode = Mode.TEXT
                CALL_OPEN -> mode = Mode.CALL
                CALL_CLOSE -> {
                    parseFcCall(call.toString())?.let { events += TurnEvent.Call(it) }
                    call.clear()
                    mode = Mode.TEXT
                }
                else -> stopped = true
            }
        }
        return events
    }

    fun finish(): List<TurnEvent> {
        val events = mutableListOf<TurnEvent>()
        if (!stopped && mode != Mode.CALL) take(pending.length, events)
        pending.clear()
        return events
    }

    private fun take(count: Int, events: MutableList<TurnEvent>) {
        if (count <= 0) return
        val text = pending.substring(0, count)
        pending.delete(0, count)
        when (mode) {
            Mode.TEXT -> events += TurnEvent.Text(text)
            Mode.THOUGHT -> events += TurnEvent.Thought(text)
            Mode.CALL -> call.append(text)
        }
    }

    private fun heldTail(markers: List<String>): Int {
        for (length in minOf(pending.length, markers.maxOf { it.length } - 1) downTo 1) {
            val tail = pending.substring(pending.length - length)
            if (markers.any { it.startsWith(tail) }) return length
        }
        return 0
    }

    companion object {
        const val THOUGHT_OPEN = "<|channel>"
        const val THOUGHT_CLOSE = "<channel|>"
        const val CALL_OPEN = "<|tool_call>"
        const val CALL_CLOSE = "<tool_call|>"
        private val TEXT_MARKERS = listOf(THOUGHT_OPEN, CALL_OPEN, "<turn|>", "<|turn>", "<|tool_response>")
    }
}

// runPrefill takes 4096 tokens max per call, 3000 chars fits even at a token per char
internal fun prefillPieces(text: String, limit: Int = 3000): List<String> {
    val pieces = mutableListOf<String>()
    var start = 0
    while (text.length - start > limit) {
        val window = text.substring(start, start + limit)
        val cut = window.lastIndexOf("<|turn>").takeIf { it > 0 }
            ?: window.lastIndexOf('\n').takeIf { it > 0 }?.plus(1)
            ?: limit
        pieces += text.substring(start, start + cut)
        start += cut
    }
    if (start < text.length) pieces += text.substring(start)
    return pieces
}

// gemma4's call syntax: call:name{key:value,...}, strings wrapped in
// <|"|>, keys and numbers bare
internal fun parseFcCall(raw: String): ParsedToolCall? {
    val body = raw.trim().removePrefix("call:")
    val open = body.indexOf('{')
    if (open <= 0) return null
    val reader = FcReader(body, open)
    val args = runCatching { reader.value() }.getOrNull() as? JsonObject ?: return null
    return ParsedToolCall(body.substring(0, open).trim(), args)
}

private class FcReader(private val s: String, private var i: Int) {
    fun value(): JsonElement {
        skipSpace()
        return when {
            s.startsWith(QUOTE, i) -> JsonPrimitive(quoted())
            s[i] == '{' -> obj()
            s[i] == '[' -> array()
            else -> bare()
        }
    }

    private fun obj(): JsonObject {
        i++
        val out = linkedMapOf<String, JsonElement>()
        while (true) {
            skipSpace()
            if (s[i] == '}') { i++; return JsonObject(out) }
            val key = if (s.startsWith(QUOTE, i)) quoted() else s.substring(i, s.indexOf(':', i)).trim().also { i += it.length }
            skipSpace()
            check(s[i] == ':')
            i++
            out[key] = value()
            skipSpace()
            if (s[i] == ',') i++
        }
    }

    private fun array(): JsonArray {
        i++
        val out = mutableListOf<JsonElement>()
        while (true) {
            skipSpace()
            if (s[i] == ']') { i++; return JsonArray(out) }
            out += value()
            skipSpace()
            if (s[i] == ',') i++
        }
    }

    private fun quoted(): String {
        i += QUOTE.length
        val end = s.indexOf(QUOTE, i)
        check(end >= 0)
        return s.substring(i, end).also { i = end + QUOTE.length }
    }

    private fun bare(): JsonElement {
        val start = i
        while (i < s.length && s[i] !in ",}]") i++
        val text = s.substring(start, i).trim()
        return when {
            text == "null" -> JsonNull
            text == "true" || text == "false" -> JsonPrimitive(text.toBoolean())
            text.toLongOrNull() != null -> JsonPrimitive(text.toLong())
            text.toDoubleOrNull() != null -> JsonPrimitive(text.toDouble())
            else -> JsonPrimitive(text)
        }
    }

    private fun skipSpace() {
        while (i < s.length && s[i].isWhitespace()) i++
    }

    companion object {
        const val QUOTE = "<|\"|>"
    }
}
