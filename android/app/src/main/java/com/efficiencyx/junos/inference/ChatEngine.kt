package com.efficiencyx.junos.inference

import android.content.Context
import android.content.Intent
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
)

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
        context.assets.open("system_prompt.txt").bufferedReader().use { it.readText().trimEnd() }
    }

    suspend fun stream(request: ChatRequest, emit: suspend (JsonElement) -> Unit) {
        require(request.messages.size <= 160 && request.messages.all {
            it.role in setOf("user", "assistant", "system") && it.content.length <= 16 * 1024
        }) { "invalid_request" }
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
        val tail = messages.lastIndex
        if (tail >= 0 && messages[tail].role == "user") {
            messages[tail] = messages[tail].copy(content = messages[tail].content + "\n\n" + liveContext)
        } else messages += ChatMessage("user", liveContext)

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
                val roundText = StringBuilder()
                engine.generate(messages).collect { token ->
                    tokenCount++
                    roundText.append(token)
                    filter.push(token).forEach { clean ->
                        visible.append(clean)
                        emit(buildJsonObject { put("token", clean) })
                    }
                }
                engine.lastStats.value?.let { stats ->
                    nativeEvalCount += stats["eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                    nativeEvalMs += stats["eval_ms"]?.jsonPrimitive?.longOrNull ?: 0
                    nativePromptEvalCount += stats["prompt_eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                }
                filter.finish().forEach { clean ->
                    visible.append(clean)
                    emit(buildJsonObject { put("token", clean) })
                }
                val calls = filter.calls
                if (calls.isEmpty()) break
                messages += ChatMessage("assistant", filter.visibleText.toString())
                for (call in calls.take(4)) {
                    emit(toolStatus(call.name, "running"))
                    val result = executeTool(call, request.conversationId)
                    emit(toolStatus(call.name, "done", result))
                    if (call.name == "stay_silent" && !request.idle) silenced = true
                    if (call.name == "flee") fled = buildJsonObject {
                        put("until", 0); put("minutes", 0); put("reason", call.args["reason"]?.jsonPrimitive?.content.orEmpty())
                    }
                    messages += ChatMessage("tool", "${call.name}: $result")
                }
                if (silenced || fled != null) break
                if (round < 2) {
                    visible.append("\n\n")
                    emit(buildJsonObject { put("token", "\n\n") })
                }
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
        memory.recentContext().takeIf { it.isNotBlank() }?.let(blocks::add)
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
        return text.replace(match.value, "").trim()
    }

    private fun now() = System.currentTimeMillis() / 1000

    companion object {
        private val MEMORY_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*memory_write\\b([^]]*)]", RegexOption.IGNORE_CASE)
        private val MOOD_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*mood_shift\\b([^]]*)]", RegexOption.IGNORE_CASE)
        private const val TOOL_PROTOCOL = """

## Local tool-call protocol
When a tool is necessary, write exactly `[TOOL:name|{"argument":"value"}]` after a short natural lead-in. The application removes the marker, executes it, and returns a tool message. Available names are search_recent_chats, list_recent_chats, search_lore, memory_write, web_search, stay_silent, and flee. Never invent another tool.
"""
    }
}

private data class ParsedToolCall(val name: String, val args: JsonObject)

private class ToolStreamFilter {
    val calls = mutableListOf<ParsedToolCall>()
    val visibleText = StringBuilder()
    private val held = StringBuilder()
    private var marker = false

    fun push(chunk: String): List<String> {
        val emitted = mutableListOf<String>()
        for (char in chunk) {
            if (marker) {
                held.append(char)
                if (char == ']') finishMarker(emitted)
                else if (held.length > 8192) flushHeld(emitted)
            } else if (char == '[') {
                marker = true
                held.append(char)
            } else append(char.toString(), emitted)
        }
        return emitted
    }

    fun finish(): List<String> = buildList { if (held.isNotEmpty()) flushHeld(this) }

    private fun finishMarker(emitted: MutableList<String>) {
        val raw = held.toString()
        val parsed = TOOL.matchEntire(raw)?.let { match ->
            runCatching {
                ParsedToolCall(match.groupValues[1], Json.parseToJsonElement(match.groupValues[2]).jsonObject)
            }.getOrNull()
        }
        if (parsed != null) calls += parsed else append(raw, emitted)
        held.clear()
        marker = false
    }

    private fun flushHeld(emitted: MutableList<String>) {
        append(held.toString(), emitted)
        held.clear()
        marker = false
    }

    private fun append(value: String, emitted: MutableList<String>) {
        visibleText.append(value)
        emitted += value
    }

    companion object {
        // Android's ICU engine rejects a bare '}' that desktop Java tolerates.
        private val TOOL = Regex("\\[TOOL:([a-z_]+)\\|(\\{.*\\})]", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    }
}
