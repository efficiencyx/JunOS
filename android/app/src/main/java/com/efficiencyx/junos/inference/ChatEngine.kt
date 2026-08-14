package com.efficiencyx.junos.inference

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.efficiencyx.junos.data.ConsolidationEntity
import com.efficiencyx.junos.data.JunDatabase
import com.efficiencyx.junos.data.MessageEntity
import com.efficiencyx.junos.data.RelationshipEntity
import com.efficiencyx.junos.lore.LoreIndex
import com.efficiencyx.junos.memory.MemoryStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

@Serializable
data class ClientMessage(val role: String, val content: String)

@Serializable
data class ChatRequest(
    val messages: List<ClientMessage>,
    val model: String? = null,
    val reasoning: String = "low",
    val think: Boolean = false,
    @SerialName("outfit_context") val outfitContext: String? = null,
    @SerialName("conversation_id") val conversationId: Long,
    val idle: Boolean = false,
    val ephemeral: Boolean = false,
    @SerialName("client_time") val clientTime: String? = null,
    val audio: String? = null,
)

internal fun ChatRequest.validate() {
    // The webapp hands the turn over as a base64 wav whenever it thinks she can
    // hear it. LiteRT has no audio input here, so we refuse before anything is
    // written down and the client redoes the turn through whisper.
    if (audio != null) error("audio_unsupported")
    require(messages.size <= 160 && messages.all {
        it.role in setOf("user", "assistant", "system") && it.content.length <= 16 * 1024
    }) { "invalid_request" }
}

class ChatEngine(
    private val context: Context,
    private val database: JunDatabase,
    private val memory: MemoryStore,
    private val lore: LoreIndex,
    private val engine: InferenceEngine,
) {
    private val dao get() = database.dao()
    private val json = Json { ignoreUnknownKeys = true }
    private val systemPrompt by lazy {
        // The php side cuts the <!--tools--> block out when a provider has no
        // tools. She always has them here, so only the marker lines go.
        context.assets.open("system_prompt.txt").bufferedReader()
            .use { it.readText().trimEnd() }
            .replace(TOOL_MARKER_LINE, "")
    }

    suspend fun stream(request: ChatRequest, emit: suspend (JsonElement) -> Unit) {
        request.validate()
        val conversation = dao.conversation(request.conversationId) ?: error("forbidden")
        dao.ensureDefaults(now())
        val lastUser = request.messages.lastOrNull { it.role == "user" }?.content.orEmpty()
        if (!request.idle && !request.ephemeral) {
            dao.insertMessage(MessageEntity(conversationId = request.conversationId, role = "user", content = lastUser, createdAt = now()))
            val consolidation = dao.consolidation() ?: ConsolidationEntity()
            dao.putConsolidation(consolidation.copy(lastActivity = now()))
        }

        val relationship = dao.relationship() ?: RelationshipEntity(updatedAt = now())
        val liveContext = buildLiveContext(request, lastUser, relationship, conversation.summary.orEmpty())
        val messages = mutableListOf(ChatMessage("system", systemPrompt + TOOL_PROTOCOL))
        request.messages.filter { it.role != "system" }.forEach { messages += ChatMessage(it.role, it.content) }
        if (request.idle) {
            messages += ChatMessage(
                "user",
                "(OOC stage direction: Anon has gone quiet. React naturally, or use only an avatar action if he asked for silence.)",
            )
        }
        // Context first, her question LAST. A 2B int4 model answers whatever it read
        // most recently, and with the context glued after the question it kept
        // replying to the memories instead of to Anon.
        val tail = messages.lastIndex
        if (tail >= 0 && messages[tail].role == "user") {
            messages[tail] = messages[tail].copy(content = liveContext + "\n\n" + messages[tail].content)
        } else messages += ChatMessage("user", liveContext)
        trimToBudget(messages)
        val baseMessages = messages.toList()

        emit(buildJsonObject { put("debug", buildJsonObject { put("live_context", liveContext); put("reasoning", request.reasoning) }) })
        val statusJob = if (engine.state.value !is EngineState.Ready) {
            emit(statusEvent("loading", 0f))
            CoroutineScope(currentCoroutineContext()).launch {
                var lastStep = -1
                engine.state.collect { state ->
                    if (state !is EngineState.Loading) return@collect
                    val step = (state.progress * 20f).toInt()
                    if (step != lastStep) {
                        lastStep = step
                        emit(statusEvent("loading", step / 20f))
                    }
                }
            }
        } else null
        // Loading the model pins gigabytes and stalls the main looper, so it has to finish before the
        // foreground service starts - Android kills the process if startForeground() is more than 5s late.
        try {
            withContext(Dispatchers.Default) { engine.ensureLoaded() }
        } finally {
            statusJob?.cancelAndJoin()
        }
        emit(statusEvent("generating", 1f))
        ContextCompat.startForegroundService(context, Intent(context, GenerationService::class.java))
        val started = System.nanoTime()
        var visible = StringBuilder()
        var silenced = false
        var fled: JsonObject? = null
        var tokenCount = 0
        var nativeEvalCount = 0
        var nativeEvalMs = 0L
        var nativePromptEvalCount = 0
        try {
            for (round in 0 until 3) {
                val filter = ToolStreamFilter()
                val think = ThinkStreamFilter()
                val roundText = StringBuilder()
                engine.generate(messages).collect { token ->
                    tokenCount++
                    roundText.append(token)
                    filter.push(think.push(token)).forEach { clean ->
                        visible.append(clean)
                        emit(buildJsonObject { put("token", clean) })
                    }
                }
                filter.push(think.finish()).forEach { clean ->
                    visible.append(clean)
                    emit(buildJsonObject { put("token", clean) })
                }
                engine.lastStats.value?.let { stats ->
                    nativeEvalCount += stats["eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                    nativeEvalMs += stats["eval_ms"]?.jsonPrimitive?.longOrNull ?: 0
                    nativePromptEvalCount += stats["prompt_eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                }
                filter.finish()
                val calls = filter.calls
                if (calls.isEmpty()) break
                val lead = filter.visibleText.toString()
                if (lead.isNotBlank()) messages += ChatMessage("assistant", lead)
                for (call in calls.take(4)) {
                    emit(toolStatus(call.name, "running"))
                    val result = executeTool(call, request.conversationId)
                    emit(toolStatus(call.name, "done", result))
                    if (call.name == "stay_silent" && !request.idle) silenced = true
                    if (call.name == "flee") fled = buildJsonObject {
                        put("until", 0); put("minutes", 0); put("reason", call.args["reason"]?.jsonPrimitive?.content.orEmpty())
                    }
                    // Not a "tool" turn. This fine-tune never saw that role in training,
                    // and handing it one is what made her come back with nothing at all,
                    // so the result goes in as something she DID see, a user turn.
                    messages += ChatMessage("user", "(Tool result, ${call.name}: $result)")
                }
                if (silenced || fled != null) break
                if (round < 2) {
                    visible.append("\n\n")
                    emit(buildJsonObject { put("token", "\n\n") })
                }
            }
            if (visible.isBlank() && !silenced && fled == null) {
                // Every round went on tools and none of them came back with prose.
                // Run it once more with the protocol taken out and the tool
                // round-trip gone, so there is nothing for her to reach for but words.
                val plain = baseMessages.toMutableList()
                plain[0] = ChatMessage("system", systemPrompt)
                val filter = ToolStreamFilter()
                val think = ThinkStreamFilter()
                engine.generate(plain).collect { token ->
                    tokenCount++
                    filter.push(think.push(token)).forEach { clean ->
                        visible.append(clean)
                        emit(buildJsonObject { put("token", clean) })
                    }
                }
                filter.push(think.finish()).forEach { clean ->
                    visible.append(clean)
                    emit(buildJsonObject { put("token", clean) })
                }
                filter.finish()
            }
        } finally {
            context.stopService(Intent(context, GenerationService::class.java))
        }

        var assistant = visible.toString().trim()
        if (silenced) {
            assistant = "..."
            emit(buildJsonObject { put("silence", buildJsonObject { put("reason", "Jun chose silence") }) })
        } else if (fled != null) {
            if (assistant.isBlank()) assistant = "..."
            emit(buildJsonObject { put("fled", fled!!) })
        }
        assistant = salvageMemoryTags(assistant, emit)
        assistant = applyRelationshipTag(assistant, relationship)
        assistant = EXIT_TAG.replace(assistant, "").trim()
        if ((silenced || fled != null) && assistant.isBlank()) assistant = "..."
        val duration = System.nanoTime() - started
        emit(buildJsonObject {
            put("stats", buildJsonObject {
                put("eval_count", if (nativeEvalCount > 0) nativeEvalCount else tokenCount)
                put("eval_duration", if (nativeEvalMs > 0) nativeEvalMs * 1_000_000 else duration)
                put("prompt_eval_count", nativePromptEvalCount)
                put("total_duration", duration)
                put("num_ctx", 4096)
                put("model", "jun-e2b-q4_k_m")
            })
        })
        if (assistant.isBlank()) error("empty_reply")
        if (!request.ephemeral) {
            dao.insertMessage(MessageEntity(conversationId = request.conversationId, role = "assistant", content = assistant, createdAt = now()))
            dao.updateConversation(conversation.copy(updatedAt = now()))
            if (conversation.title.isNullOrBlank()) {
                val title = lastUser.replace(Regex("\\s+"), " ").trim().take(60).ifBlank { "New chat" }
                dao.renameConversation(request.conversationId, title, now())
            }
        }
    }

    fun cancel() = engine.cancel()

    suspend fun summarize(oldSummary: String, messages: List<MessageEntity>): String {
        val lines = messages.mapNotNull { message ->
            val clean = message.content.replace(Regex("\\[\\s*A(?:CTIONS?)?\\s*:[^]]*]", RegexOption.IGNORE_CASE), "")
                .replace(Regex("\\s+"), " ").trim()
            clean.takeIf { it.isNotBlank() }?.let { "${if (message.role == "assistant") "Jun" else "Anon"}: $it" }
        }
        if (lines.isEmpty()) return oldSummary
        val request = buildString {
            if (oldSummary.isNotBlank()) append("Current memory:\n").append(oldSummary).append("\n\n")
            append("New lines to fold in:\n").append(lines.joinToString("\n"))
        }
        val prompt = listOf(
            ChatMessage(
                "system",
                "Maintain a running memory of an ongoing roleplay between Anon and Jun. Rewrite it to include the new lines. Preserve concrete facts, decisions, promises, emotional beats, and anything Jun should remember. Drop small talk, stay under 300 words, and output only the updated third-person summary.",
            ),
            ChatMessage("user", request),
        )
        return buildString { engine.generate(prompt, maxTokens = 512).collect(::append) }.trim().ifBlank { oldSummary }
    }

    private suspend fun buildLiveContext(
        request: ChatRequest,
        lastUser: String,
        relationship: RelationshipEntity,
        summary: String,
    ): String {
        val blocks = mutableListOf<String>()
        blocks += "## Current date and time\nIt is currently ${request.clientTime?.take(80) ?: java.time.ZonedDateTime.now()}."
        memory.recentContext(1200).takeIf { it.isNotBlank() }?.let(blocks::add)
        if (summary.isNotBlank()) blocks += "## Story so far (earlier in THIS conversation)\n$summary"
        val facts = lore.search(lastUser, 5)
        if (facts.isNotEmpty()) blocks += "## World facts (canon)\n" + facts.joinToString("\n") { "- ${it.text}" }
        request.outfitContext?.trim()?.takeIf { it.isNotBlank() }?.let { blocks += "## Current Wardrobe State\n$it" }
        blocks += "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n" +
            "- Affection: ${relationship.affection}/100\n- Trust: ${relationship.trust}/100\n- Tension: ${relationship.tension}/100"
        blocks += "## Save check\nIf Anon's latest message contains a durable personal fact, preference, plan, boundary, or health matter, call memory_write before replying."
        return "# Live context for THIS reply (from the system, not spoken by Anon)\n\n" + blocks.joinToString("\n\n")
    }

    private suspend fun executeTool(call: ParsedToolCall, conversationId: Long): String = when (call.name) {
        "search_lore" -> {
            val query = call.args["query"]?.jsonPrimitive?.content.orEmpty()
            json.encodeToString(lore.search(query, call.args["limit"]?.jsonPrimitive?.intOrNull ?: 5).map { it.text })
        }
        "memory_write" -> {
            val note = memory.add(
                call.args["category"]?.jsonPrimitive?.content ?: "events",
                call.args["memory"]?.jsonPrimitive?.content.orEmpty(),
            )
            json.encodeToString(mapOf("saved" to note.id))
        }
        "search_recent_chats" -> {
            val query = call.args["query"]?.jsonPrimitive?.content.orEmpty()
            val hits = dao.searchMessages(query, (call.args["limit"]?.jsonPrimitive?.intOrNull ?: 5).coerceIn(1, 8))
                .filter { it.conversationId != conversationId }
                .map { mapOf("conversation_id" to it.conversationId.toString(), "role" to it.role, "content" to it.content.take(500)) }
            json.encodeToString(hits)
        }
        "list_recent_chats" -> json.encodeToString(dao.conversations(10).filter { it.id != conversationId }.map {
            mapOf("id" to it.id.toString(), "title" to (it.title ?: "Untitled"))
        })
        "web_search" -> json.encodeToString(mapOf("error" to "network_search_unavailable_offline"))
        "stay_silent" -> json.encodeToString(mapOf("silent" to true))
        "flee" -> json.encodeToString(mapOf("fled" to true))
        else -> json.encodeToString(mapOf("error" to "unknown_tool"))
    }

    private fun statusEvent(phase: String, progress: Float) = buildJsonObject {
        put("status", buildJsonObject { put("phase", phase); put("progress", progress) })
    }

    private fun toolStatus(name: String, state: String, result: String? = null) = buildJsonObject {
        put("tool_status", buildJsonObject {
            put("name", name); put("state", state)
            if (result != null) put("result", result.take(2000))
        })
    }

    private suspend fun salvageMemoryTags(text: String, emit: suspend (JsonElement) -> Unit): String {
        var clean = text
        for (match in MEMORY_TAG.findAll(text).toList()) {
            val args = match.groupValues[1]
            val category = Regex("category\\s*=\\s*([^,|]+)", RegexOption.IGNORE_CASE).find(args)?.groupValues?.get(1) ?: "events"
            val value = Regex("memory\\s*=\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
                .find(args)?.groupValues?.get(1)?.trim() ?: continue
            val note = memory.add(category.trim(), value)
            emit(toolStatus("memory_write", "done", json.encodeToString(mapOf("saved" to note.id))))
            clean = clean.replace(match.value, "")
        }
        return clean.trim()
    }

    private suspend fun applyRelationshipTag(text: String, current: RelationshipEntity): String {
        val match = MOOD_TAG.find(text) ?: return text.trim()
        fun delta(key: String) = Regex("$key\\s*=\\s*([+-]?\\d+)", RegexOption.IGNORE_CASE)
            .find(match.groupValues[1])?.groupValues?.get(1)?.toIntOrNull() ?: 0
        dao.putRelationship(
            current.copy(
                affection = (current.affection + delta("affection")).coerceIn(0, 100),
                trust = (current.trust + delta("trust")).coerceIn(0, 100),
                tension = (current.tension + delta("tension")).coerceIn(0, 100),
                updatedAt = now(),
            ),
        )
        return MOOD_TAG.replace(text, "").trim()
    }

    // 4096 total context, 768 of it reserved for her reply. The system prompt and the
    // live context alone can fill most of what's left, and past that the runtime just
    // cuts the front of the prompt off, so we drop whole old turns instead. System
    // message and the turn she has to answer both stay, always.
    private fun trimToBudget(messages: MutableList<ChatMessage>) {
        fun estimate() = messages.sumOf { it.content.length } / 4
        while (estimate() > PROMPT_TOKEN_BUDGET && messages.size > 2) messages.removeAt(1)
    }

    private fun now() = System.currentTimeMillis() / 1000

    companion object {
        private val MEMORY_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*memory_write\\b([^]]*)]", RegexOption.IGNORE_CASE)
        private val MOOD_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*mood_shift\\b([^]]*)]", RegexOption.IGNORE_CASE)
        private val EXIT_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*(?:flee|stay_silent)\\b[^]]*]", RegexOption.IGNORE_CASE)
        private val TOOL_MARKER_LINE = Regex("(?m)^<!--/?tools-->\\R")
        private const val PROMPT_TOKEN_BUDGET = 3300
        private const val TOOL_PROTOCOL = """

## Local tool-call protocol
When a tool is necessary, write exactly `[TOOL:name|{"argument":"value"}]` after a short natural lead-in. The application removes the marker, executes it, and returns a tool message. Available names are search_recent_chats, list_recent_chats, search_lore, memory_write, web_search, stay_silent, and flee. Never invent another tool.
"""
    }
}

internal data class ParsedToolCall(val name: String, val args: JsonObject)

internal class ToolStreamFilter {
    val calls = mutableListOf<ParsedToolCall>()
    val visibleText = StringBuilder()
    private val held = StringBuilder()
    private var marker = false
    private var depth = 0
    private var inString = false
    private var escaped = false
    private var discarding = false

    fun push(chunk: String): List<String> {
        val emitted = mutableListOf<String>()
        for (char in chunk) {
            if (discarding) {
                scanArgument(char)
                if (char == ']' && depth == 0 && !inString) reset()
            } else if (marker) {
                held.append(char)
                // Hold ONLY while the text can still turn into "[TOOL:". Anything else,
                // her own [A:emote|happy] tags most of all, goes straight back out, so
                // roleplay tags reach the JS filter without stalling the stream.
                if (!pastPrefix()) {
                    if (!stillCouldBeTool()) flushHeld(emitted)
                } else {
                    scanArgument(char)
                    if (char == ']' && depth == 0 && !inString) finishMarker()
                    else if (held.length > MAX_HELD) {
                        // Too long to be a real call. Keep swallowing to the closing
                        // bracket anyway, otherwise the tail of the blob prints.
                        Log.w("ToolStreamFilter", "dropped overflow marker: ${held.take(200)}")
                        held.clear()
                        marker = false
                        discarding = true
                    }
                }
            } else if (char == '[') {
                marker = true
                held.append(char)
            } else append(char.toString(), emitted)
        }
        return emitted
    }

    fun finish(): List<String> {
        if (held.isNotEmpty()) dropHeld("truncated")
        discarding = false
        return emptyList()
    }

    private fun squashed() = held.filterNot { it.isWhitespace() }

    private fun stillCouldBeTool(): Boolean {
        val seen = squashed()
        return PREFIX.regionMatches(0, seen, 0, seen.length, ignoreCase = true)
    }

    private fun pastPrefix() = squashed().length > PREFIX.length

    private fun scanArgument(char: Char) {
        if (inString) {
            when {
                escaped -> escaped = false
                char == '\\' -> escaped = true
                char == '"' -> inString = false
            }
        } else when (char) {
            '"' -> inString = true
            '{' -> depth++
            '}' -> depth--
        }
    }

    private fun finishMarker() {
        val raw = held.toString()
        val parsed = TOOL.matchEntire(raw)?.let { match ->
            runCatching {
                ParsedToolCall(match.groupValues[1], Json.parseToJsonElement(match.groupValues[2]).jsonObject)
            }.getOrNull()
        }
        if (parsed == null) {
            dropHeld("unparsable")
            return
        }
        calls += parsed
        reset()
    }

    // Fails closed on purpose. A marker we can't read costs a tool call, which is
    // annoying, printing it costs Jun a line of JSON in her mouth and it gets saved
    // to Room and replayed on every history load after that.
    private fun dropHeld(why: String) {
        Log.w("ToolStreamFilter", "dropped $why marker: ${held.take(200)}")
        reset()
    }

    private fun flushHeld(emitted: MutableList<String>) {
        append(held.toString(), emitted)
        reset()
    }

    private fun reset() {
        held.clear()
        marker = false
        depth = 0
        inString = false
        escaped = false
        discarding = false
    }

    private fun append(value: String, emitted: MutableList<String>) {
        visibleText.append(value)
        emitted += value
    }

    companion object {
        private const val PREFIX = "[TOOL:"
        private const val MAX_HELD = 8192

        // Android's ICU engine rejects a bare '}' that desktop Java tolerates.
        private val TOOL = Regex(
            "\\[\\s*TOOL\\s*:\\s*([a-z_]+)\\s*\\|\\s*(\\{.*\\})\\s*]",
            setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
        )
    }
}

// Some builds wrap reasoning in <think>...</think>. The tags arrive split across
// tokens, so we hold anything that can still become one and drop the block whole.
internal class ThinkStreamFilter {
    private val held = StringBuilder()
    private var inside = false

    fun push(chunk: String): String {
        val out = StringBuilder()
        for (char in chunk) {
            if (held.isEmpty() && char != '<') {
                if (!inside) out.append(char)
                continue
            }
            held.append(char)
            val tag = if (inside) CLOSE else OPEN
            if (tag.regionMatches(0, held.toString(), 0, held.length, ignoreCase = true)) {
                if (held.length == tag.length) {
                    inside = !inside
                    held.clear()
                }
            } else {
                val restart = char == '<'
                if (!inside) {
                    out.append(held, 0, held.length - 1)
                    if (!restart) out.append(char)
                }
                held.clear()
                if (restart) held.append(char)
            }
        }
        return out.toString()
    }

    fun finish(): String {
        val tail = if (inside) "" else held.toString()
        held.clear()
        return tail
    }

    private companion object {
        const val OPEN = "<think>"
        const val CLOSE = "</think>"
    }
}
