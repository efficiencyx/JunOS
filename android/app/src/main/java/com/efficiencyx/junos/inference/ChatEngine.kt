package com.efficiencyx.junos.inference

import android.content.Context
import android.util.Log
import androidx.core.content.ContextCompat
import com.efficiencyx.junos.data.ConsolidationEntity
import com.efficiencyx.junos.data.JunDatabase
import com.efficiencyx.junos.data.MessageEntity
import com.efficiencyx.junos.data.RelationshipEntity
import com.efficiencyx.junos.data.WardrobeStateEntity
import com.efficiencyx.junos.lore.LoreIndex
import com.efficiencyx.junos.memory.MemoryStore
import com.efficiencyx.junos.memory.NoteSource
import com.efficiencyx.junos.wardrobe.Wardrobe
import com.efficiencyx.junos.wardrobe.WardrobeState
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
import kotlinx.serialization.json.contentOrNull
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
    val voice: Boolean = false,
    @SerialName("hear_all") val hearAll: Boolean = false,
    @SerialName("mod_items") val modItems: List<String> = emptyList(),
    val invite: String = "",
    val regenerate: Boolean = false,
)

internal fun ChatRequest.validate() {
    // the webapp sends a base64 WAV when it thinks she can hear it.
    // LiteRT has no audio input here, so refuse before writing
    // anything down and let the client retry through whisper.
    if (audio != null) error("audio_unsupported")
    require(messages.all {
        it.role in setOf("user", "assistant", "system") && it.content.length <= 16 * 1024
    }) { "invalid_request" }
}

class ChatEngine(
    private val context: Context,
    private val database: JunDatabase,
    private val memory: MemoryStore,
    private val lore: LoreIndex,
    private val engines: () -> InferenceEngine,
) {
    private val engine get() = engines()
    private val dao get() = database.dao()
    private val json = Json { ignoreUnknownKeys = true }
    private val systemPrompt by lazy {
        // the php side cuts the <!--tools--> block out when a provider has no
        // tools. she always has them here, so only the marker lines go.
        context.assets.open("system_prompt.txt").bufferedReader()
            .use { it.readText().trimEnd() }
            .replace(TOOL_MARKER_LINE, "")
    }

    suspend fun stream(incoming: ChatRequest, emit: suspend (JsonElement) -> Unit) {
        val engine = engine
        incoming.validate()
        val request = incoming.copy(messages = incoming.messages.drop(blockCut(incoming.messages.size - 160, 40)))
        val modItems = request.modItems.take(60)
            .map { it.replace(CONTROL_CHARS, " ").trim() }
            .filter { it.isNotEmpty() }
            .map { it.take(80) }
        val conversation = dao.conversation(request.conversationId) ?: error("forbidden")
        dao.ensureDefaults(now())
        val lastUser = request.messages.lastOrNull { it.role == "user" }?.content.orEmpty()
        val invite = when {
            request.idle -> ""
            request.invite in Trips.TOOLS.values -> request.invite
            request.ephemeral -> ""
            else -> Trips.guessInvite(lastUser, request.messages.lastOrNull { it.role == "assistant" }?.content.orEmpty())
        }
        var noteSource = NoteSource("chat", request.conversationId)
        if (!request.idle && !request.ephemeral) {
            val stored = if (request.regenerate) dao.messages(request.conversationId).lastOrNull()?.takeIf { it.role == "user" } else null
            val userRowId = stored?.id ?: dao.insertMessage(MessageEntity(conversationId = request.conversationId, role = "user", content = lastUser, createdAt = now()))
            noteSource = noteSource.copy(msg = userRowId)
            val consolidation = dao.consolidation() ?: ConsolidationEntity()
            dao.putConsolidation(consolidation.copy(lastActivity = now()))
        }

        val relationship = dao.relationship() ?: RelationshipEntity(updatedAt = now())
        val liveContext = buildLiveContext(request, lastUser, relationship, conversation.summary.orEmpty(), invite)
        val journal = memory.journalText()
        val system = if (journal.isBlank()) systemPrompt else "$systemPrompt\n\n$JOURNAL_HEADER$journal"
        val messages = mutableListOf(ChatMessage("system", system))
        request.messages.filter { it.role != "system" }.forEach { messages += ChatMessage(it.role, it.content) }
        if (request.idle) messages += ChatMessage("user", IDLE_NUDGE)
        // his words FIRST, context after. same as chat.php, and the
        // only shape v8 ever saw (all 2150 rows are user_text +
        // "\n\n# Live context ..."). this used to be context first
        // on the theory that a 2B int4 answers whatever it read
        // last. measured 2026-10-22, 250 eval questions on the v8
        // E2B Q4_K_M, same seed both ways: context first got 146
        // right tool calls vs 162, 16 empty replies vs 10, and a
        // blind read of who answers HIM came out 10 to 9. so no.
        val tail = messages.lastIndex
        if (tail >= 0 && messages[tail].role == "user") {
            messages[tail] = messages[tail].copy(content = messages[tail].content + "\n\n" + liveContext)
        } else messages += ChatMessage("user", liveContext)
        val (reasoning, think) = reasoningFor(request, lastUser)
        // dead last, after the live context. v8 rows end every user
        // turn with "\n\n<think:LEVEL>" and the names are low/med/high
        val last = messages.lastIndex
        messages[last] = messages[last].copy(content = messages[last].content + "\n\n<think:$reasoning>")
        trimToBudget(messages, engine.contextTokens)
        val baseMessages = messages.toList()

        emit(buildJsonObject {
            put("debug", buildJsonObject {
                put("system_prompt", baseMessages.first().content); put("live_context", liveContext)
                put("user_turn", baseMessages.last().content); put("audio_attached", false)
                put("reasoning", reasoning); put("think", think)
            })
        })
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
        // loading pins gigabytes and stalls the main looper. it has to
        // finish before the foreground service starts, android kills
        // the process if startForeground() is more than 5s late.
        try {
            withContext(Dispatchers.Default) { engine.ensureLoaded() }
        } finally {
            statusJob?.cancelAndJoin()
        }
        emit(statusEvent("generating", 1f))
        ContextCompat.startForegroundService(context, GenerationService.intent(context, engine.label))
        val started = System.nanoTime()
        var visible = StringBuilder()
        var silenced = false
        var fled: JsonObject? = null
        var tokenCount = 0
        var nativeEvalCount = 0
        var nativeEvalMs = 0L
        var nativePromptEvalCount = 0
        var went = ""
        suspend fun goOut(where: String): String {
            if (request.idle) return json.encodeToString(mapOf("error" to "not_available_on_idle"))
            if (where == "karaoke") return buildJsonObject { put("started", false); put("note", KARAOKE_CLOSED) }.toString()
            if (where != "cards") Trips.current = Trip(where, now(), request.conversationId)
            emit(buildJsonObject { put("go", where) })
            went = where
            return buildJsonObject {
                put("going", where)
                put("note", if (where == "cards") "Say one short line. The table opens the moment you finish talking."
                    else "Say one short line about heading out together. The trip starts the moment you finish talking.")
            }.toString()
        }
        try {
            suspend fun show(text: String, into: StringBuilder) {
                if (text.isEmpty()) return
                into.append(text)
                visible.append(text)
                emit(buildJsonObject { put("token", text) })
            }
            suspend fun streamThoughts(thoughts: ThinkStreamFilter) {
                val thought = thoughts.drainThought()
                if (thought.isNotEmpty()) emit(buildJsonObject { put("thinking", thought) })
            }
            for (round in 0 until 3) {
                val thoughts = ThinkStreamFilter()
                val lead = StringBuilder()
                val calls = mutableListOf<ParsedToolCall>()
                engine.turn(messages, TOOL_SCHEMAS, think, replyTokens(think), reasoning = reasoning).collect { event ->
                    when (event) {
                        is TurnEvent.Text -> {
                            tokenCount++
                            show(thoughts.push(event.text), lead)
                            streamThoughts(thoughts)
                        }
                        is TurnEvent.Thought -> emit(buildJsonObject { put("thinking", event.text) })
                        is TurnEvent.Call -> calls += event.call
                    }
                }
                show(thoughts.finish(), lead)
                streamThoughts(thoughts)
                engine.lastStats.value?.let { stats ->
                    nativeEvalCount += stats["eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                    nativeEvalMs += stats["eval_ms"]?.jsonPrimitive?.longOrNull ?: 0
                    nativePromptEvalCount += stats["prompt_eval_count"]?.jsonPrimitive?.intOrNull ?: 0
                }
                if (calls.isEmpty()) break
                val ran = calls.take(4)
                messages += ChatMessage("assistant", lead.toString(), toolCalls = ran)
                for (call in ran) {
                    emit(toolStatus(call.name, "running", raw = buildJsonObject {
                        put("call", buildJsonObject { put("name", call.name); put("arguments", call.args) })
                    }))
                    val trip = Trips.TOOLS[call.name]
                    val result = when {
                        call.name == "change_outfit" -> changeOutfit(call.args, modItems, emit)
                        trip != null -> goOut(trip)
                        else -> executeTool(call, request.conversationId, noteSource)
                    }
                    emit(toolStatus(call.name, "done", result, raw = buildJsonObject {
                        put("message", buildJsonObject { put("role", "tool"); put("name", call.name); put("content", result) })
                    }))
                    if (call.name == "stay_silent" && !request.idle) silenced = true
                    if (call.name == "flee") fled = buildJsonObject {
                        put("until", 0); put("minutes", 0); put("reason", call.args["reason"]?.jsonPrimitive?.content.orEmpty())
                    }
                    messages += ChatMessage("tool", result, toolName = call.name)
                }
                if (silenced || fled != null) break
                if (round < 2 && lead.isNotBlank()) show("\n\n", lead)
            }
            if (visible.isBlank() && !silenced && fled == null) {
                // every round used tools and not one came back with prose.
                // once more with no tools offered and no round trip, so
                // there's nothing left to reach for but words.
                val thoughts = ThinkStreamFilter()
                val plain = StringBuilder()
                engine.turn(baseMessages, emptyList(), think, replyTokens(think), reasoning = reasoning).collect { event ->
                    if (event is TurnEvent.Text) {
                        tokenCount++
                        show(thoughts.push(event.text), plain)
                        streamThoughts(thoughts)
                    } else if (event is TurnEvent.Thought) {
                        emit(buildJsonObject { put("thinking", event.text) })
                    }
                }
                show(thoughts.finish(), plain)
                streamThoughts(thoughts)
            }
        } finally {
            GenerationService.stop(context)
        }
        // she said yes in words and called nothing. go anyway, same as chat.php
        if (invite.isNotEmpty() && went.isEmpty() && !silenced && fled == null && Trips.replyAccepts(visible.toString())) {
            goOut(invite)
        }

        var assistant = visible.toString().trim()
        if (silenced) {
            assistant = "..."
            emit(buildJsonObject { put("silence", buildJsonObject { put("reason", "Jun chose silence") }) })
        } else if (fled != null) {
            if (assistant.isBlank()) assistant = "..."
            emit(buildJsonObject { put("fled", fled!!) })
        }
        assistant = salvageMemoryTags(assistant, noteSource, emit)
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
                put("num_ctx", engine.contextTokens)
                put("model", engine.lastStats.value?.get("model")?.jsonPrimitive?.contentOrNull ?: "jun-e2b-v8-litert")
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
        if (!request.idle && !request.ephemeral && request.messages.lastOrNull()?.role == "user") {
            engine.warm(baseMessages.dropLast(1) + ChatMessage("user", lastUser), TOOL_SCHEMAS, think)
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
        invite: String,
    ): String {
        val feelings = "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n" +
            "- Affection: ${relationship.affection}/100\n- Trust: ${relationship.trust}/100\n- Tension: ${relationship.tension}/100"
        // invite turn: one OOC line naming the tool + feelings, nothing
        // else. lore about the shop just pulls her off the question
        if (invite.isNotEmpty()) {
            val tool = Trips.TOOLS.entries.first { it.value == invite }.key
            return LIVE_CONTEXT_HEADER + "(OOC stage direction, not spoken by Anon: Anon wants to ${INVITE_PLANS.getValue(invite)}. " +
                "If you wish to go along with it, invoke the tool $tool.)\n\n" + feelings
        }
        val blocks = mutableListOf<String>()
        // first block, same as chat.php. it only works up top
        if (request.voice && !request.hearAll) blocks += SIDE_TALK_CHECK
        blocks += "## Current date and time\nIt is currently ${request.clientTime?.take(80) ?: java.time.ZonedDateTime.now()}."
        memory.recentContext(1200).takeIf { it.isNotBlank() }?.let(blocks::add)
        if (summary.isNotBlank()) blocks += "## Story so far (earlier in THIS conversation)\n$summary"
        val facts = lore.search(lastUser, 5)
        if (facts.isNotEmpty()) blocks += "## World facts (canon)\n" + facts.joinToString("\n") { "- ${it.text}" }
        request.outfitContext?.trim()?.takeIf { it.isNotBlank() }?.let { blocks += "## Current Wardrobe State\n$it" }
        blocks += feelings
        blocks += "## Save check\n" +
            "If Anon's latest message contains something durable (a preference, personal fact, plan, " +
            "boundary, health/safety matter, or something emotionally significant), call memory_write " +
            "before replying. Otherwise ignore this."
        return LIVE_CONTEXT_HEADER + blocks.joinToString("\n\n")
    }

    private suspend fun executeTool(call: ParsedToolCall, conversationId: Long, noteSource: NoteSource): String = when (call.name) {
        "search_lore" -> {
            val query = call.args["query"]?.jsonPrimitive?.content.orEmpty()
            json.encodeToString(lore.search(query, call.args["limit"]?.jsonPrimitive?.intOrNull ?: 5).map { it.text })
        }
        "memory_write" -> {
            val note = memory.add(
                call.args["category"]?.jsonPrimitive?.content ?: "events",
                call.args["memory"]?.jsonPrimitive?.content.orEmpty(),
                noteSource,
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

    // the browser owns what's on screen, so it gets the change as its
    // own frame instead of parsing it back out of the tool result
    private suspend fun changeOutfit(args: JsonObject, modItems: List<String>, emit: suspend (JsonElement) -> Unit): String {
        val stored = dao.wardrobeState()?.let { runCatching { json.decodeFromString<WardrobeState>(it.data) }.getOrNull() }
        val presets = dao.wardrobePresets().sortedBy { it.name.lowercase() }
            .mapNotNull { row -> (runCatching { json.parseToJsonElement(row.data) }.getOrNull() as? JsonObject)?.let { row.name to it } }
            .toMap()
        val outcome = Wardrobe.toolChange(Wardrobe.toolState(stored), args, modItems, presets)
        outcome.state?.let { dao.putWardrobeState(WardrobeStateEntity(data = json.encodeToString(it), updatedAt = now())) }
        outcome.apply?.let { emit(buildJsonObject { put("outfit", it) }) }
        return outcome.reply.toString()
    }

    private fun statusEvent(phase: String, progress: Float) = buildJsonObject {
        put("status", buildJsonObject { put("phase", phase); put("progress", progress) })
    }

    private fun toolStatus(name: String, state: String, result: String? = null, raw: JsonObject? = null) = buildJsonObject {
        put("tool_status", buildJsonObject {
            put("name", name); put("state", state)
            if (result != null) put("result", result.take(2000))
            raw?.forEach { (key, value) -> put(key, value) }
        })
    }

    private suspend fun salvageMemoryTags(text: String, noteSource: NoteSource, emit: suspend (JsonElement) -> Unit): String {
        var clean = text
        for (match in MEMORY_TAG.findAll(text).toList()) {
            val args = match.groupValues[1]
            val category = Regex("category\\s*=\\s*([^,|]+)", RegexOption.IGNORE_CASE).find(args)?.groupValues?.get(1) ?: "events"
            val value = Regex("memory\\s*=\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
                .find(args)?.groupValues?.get(1)?.trim() ?: continue
            val note = memory.add(category.trim(), value, noteSource)
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

    // the engine's context minus 2048 for her reply, a <think:high>
    // trace comes BEFORE the reply and eats from the same budget.
    // the tool declarations ride in the system turn so they count
    // too. past the cache the runtime just lops the front off, so we
    // drop whole old turns instead. system message + the turn she
    // must answer always stay. 16 at a time, a cut that moves every turn resets every KV cache every turn
    private fun trimToBudget(messages: MutableList<ChatMessage>, contextTokens: Int) {
        val budget = (contextTokens - REPLY_RESERVE).coerceAtLeast(2048)
        fun estimate() = (messages.sumOf { it.content.length } + TOOL_SCHEMA_CHARS) / 4
        while (estimate() > budget && messages.size > 2) {
            messages.subList(1, minOf(1 + TRIM_STEP, messages.size - 1)).clear()
        }
    }

    // chat.php's level picker, same rules. the webapp sends "auto" by
    // default, and ephemeral turns (cards, touch) never think, a hit
    // or stand behind 20 s of trace kills the game
    private fun reasoningFor(request: ChatRequest, lastUser: String): Pair<String, Boolean> {
        if (request.ephemeral) return "low" to false
        return when (request.reasoning) {
            "auto" -> routeReasoning(lastUser, request.idle)
            "medium" -> "med" to request.think
            "high" -> "high" to request.think
            else -> "low" to request.think
        }
    }

    private fun routeReasoning(message: String, idle: Boolean): Pair<String, Boolean> {
        val m = message.trim().lowercase()
        if (idle || m.isEmpty()) return "low" to false
        val words = m.split(Regex("\\s+")).count { it.isNotEmpty() }
        val signals = listOfNotNull(
            "analytical".takeIf { ANALYTICAL.containsMatchIn(m) },
            "quantitative".takeIf { ARITHMETIC.containsMatchIn(m) || QUANTITATIVE.containsMatchIn(m) },
            "multi-question".takeIf { m.count { it == '?' } >= 2 },
            "long".takeIf { words >= 25 },
        )
        if (signals.isEmpty()) return "low" to false
        return (if (signals.size >= 2 || words >= 60) "high" else "med") to true
    }

    private fun replyTokens(think: Boolean) = if (think) 2048 else 1024

    private fun now() = System.currentTimeMillis() / 1000

    companion object {
        private val MEMORY_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*memory_write\\b([^]]*)]", RegexOption.IGNORE_CASE)
        // the closing ] is optional, at the very end only. litertlm
        // 0.16 dropped the last token of every reply and the tag is
        // always last, so the bookkeeping never applied. 0.18 is
        // fixed, this is the seatbelt
        private val MOOD_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*mood_shift\\b([^]\\n]*)(?:]|\\s*$)", RegexOption.IGNORE_CASE)
        private val EXIT_TAG = Regex("\\[\\s*A(?:CTIONS?)?\\s*:\\s*(?:flee|stay_silent)\\b[^]]*]", RegexOption.IGNORE_CASE)
        private val TOOL_MARKER_LINE = Regex("(?m)^<!--/?tools-->\\R")
        private val CONTROL_CHARS = Regex("[\\x00-\\x1F\\x7F]+")
        private val ANALYTICAL = Regex(
            "\\b(explain|why|how (?:do|does|did|can|would|should|to)|calculat|comput|solve|prove|deriv|reason|" +
                "analy[sz]|compare|difference between|step by step|walk me through|figure out|work out|plan|strateg|" +
                "debug|optimi[sz]|translate|summar|pros and cons|which is better|trade-?off)\\b",
        )
        private val ARITHMETIC = Regex("\\d+\\s*[-+*/x×÷%=]\\s*\\d+")
        private val QUANTITATIVE = Regex(
            "\\b(how many|how much|how long|how old|days? (?:since|ago|until)|hours? (?:since|ago)|what time|" +
                "percentage|average|total)\\b",
        )
        private const val REPLY_RESERVE = 2192
        private const val TRIM_STEP = 16
        private const val LIVE_CONTEXT_HEADER = "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
        private val INVITE_PLANS = mapOf(
            "shop" to "go to Annalie's shop together",
            "karaoke" to "go to karaoke together",
            "date" to "go out to eat together",
            "cards" to "play a game of blackjack",
        )
        private const val KARAOKE_CLOSED = "The karaoke room is closed right now (there is no karaoke on the phone). " +
            "Tell Anon plainly, do not pretend to sing."
        private const val SIDE_TALK_CHECK = "## Who he is talking to\n" +
            "He said this out loud and he is not alone in the room. Before you answer, check that the line fits " +
            "as something said TO YOU, following what you two were just saying. A line with no question or remark " +
            "for you, about objects, food, a game on TV, chores, or another person, is him talking to someone else " +
            "in the room. Talking about you in the third person (she, her, the girl) is also not for you." +
            " Unless it is clearly for you, call stay_silent with overheard=true. Staying quiet costs nothing, " +
            "answering a conversation you are not part of is embarrassing."
        private const val JOURNAL_HEADER = "# My memory of us\n\n" +
            "These are your own notes on everything you and Anon have been through, written by you " +
            "while he wasn't around. What happened recently you still remember clearly; the further " +
            "back it goes, the more it has faded to just the shape of what happened.\n\n"
        private const val IDLE_NUDGE = "(OOC stage direction, not spoken by Anon: Anon has gone quiet and is just " +
            "saying nothing. The silence has stretched on. " +
            "Unless he specifically asked you to be quiet say or do something on your own initiative, the way Jun " +
            "naturally would when Anon goes still and stares at her. " +
            "If asked to be quiet Break the silence with ONLY an action. such as a wave or a smile. No chat or text!)"

        // chat.php's declarations, word for word, for the tools the
        // phone can actually carry out. no web_search (offline)
        internal val TOOL_SCHEMAS = listOf(
            """{"type":"function","function":{"name":"search_recent_chats","description":"Search your saved chat history with Anon for a specific past topic he references or that you don't recall.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"What to search for."},"limit":{"type":"integer","description":"Max messages, 1-8."}},"required":["query"]}}}""",
            """{"type":"function","function":{"name":"list_recent_chats","description":"Recap your most recent conversations with Anon when he wants to catch up, with no specific topic.","parameters":{"type":"object","properties":{"limit":{"type":"integer","description":"How many to recap, 1-10."}}}}}""",
            """{"type":"function","function":{"name":"search_lore","description":"Look up canon world facts - people, places, jobs, events from your own world - when you are unsure of a detail.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"Name or topic to look up."},"limit":{"type":"integer","description":"Max facts, 1-6."}},"required":["query"]}}}""",
            """{"type":"function","function":{"name":"memory_write","description":"Save a durable note about Anon (a preference, fact, plan, boundary, or something emotionally significant). Use often and proactively, not only when asked.","parameters":{"type":"object","properties":{"memory":{"type":"string","description":"One concise fact to remember."},"category":{"type":"string","description":"Category: preferences, work, health, family, plans, boundaries, or events."}},"required":["memory"]}}}""",
            """{"type":"function","function":{"name":"change_outfit","description":"Put clothes on or take them off. Calling this is the ONLY thing that actually changes what you are wearing - describing a change in your reply does not move a single thread. It answers with what you have on afterwards, so call it BEFORE you say anything about your clothes.","parameters":{"type":"object","properties":{"put_on":{"type":"array","items":{"type":"string"},"description":"Items to put on. Use the names listed in your current wardrobe state."},"take_off":{"type":"array","items":{"type":"string"},"description":"Items to take off. \"nude\" takes off all of your clothes at once."},"look":{"type":"string","description":"Name of a saved look to put on whole, from the saved looks in your wardrobe state. Overrides put_on and take_off."}}}}}""",
            """{"type":"function","function":{"name":"stay_silent","description":"Say nothing at all this turn - ignoring him, too hurt/angry, the scene calls for silence, or he wasn't talking to you at all (someone else in the room, a phone call, the TV). Sends no message.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why (private)."},"overheard":{"type":"boolean","description":"true when what he said was aimed at someone else, not you."}}}}}""",
            """{"type":"function","function":{"name":"flee","description":"Walk out and leave Anon alone. Call it when you want to go.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why you are leaving."},"destination":{"type":"string","description":"Where you're going, if anywhere."}}}}}""",
            """{"type":"function","function":{"name":"enter_shop","description":"Go to Annalie's clothes shop together with Anon to browse and try things on. Call it once the two of you agree to go, then say your line - you both leave for the shop when you finish talking.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why you two are going (private)."}}}}}""",
            """{"type":"function","function":{"name":"enter_karaoke","description":"Start a karaoke date with Anon: you two pick a song and sing it together. Call it once the two of you agree to sing, then say your line - the karaoke starts when you finish talking. It tells you if the karaoke room is closed.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why you two are going (private)."}}}}}""",
            """{"type":"function","function":{"name":"play_cards","description":"Play a game of blackjack with Anon at the table, you deal. Call it once you two agree to play, then say your line - the table opens when you finish talking.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why you want to play (private)."}}}}}""",
            """{"type":"function","function":{"name":"go_out_to_eat","description":"Go out for lunch or dinner with Anon at a restaurant, whether he is taking you out to eat or you asked him. Call it once the two of you agree to go, then say your line - you both leave when you finish talking.","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"Why you two are going (private)."}}}}}""",
        )
        private val TOOL_SCHEMA_CHARS = TOOL_SCHEMAS.sumOf { it.length }
    }
}

// some builds wrap reasoning in <think>...</think>. the tags
// split across tokens, so hold any partial tag and keep the whole
// block out of the reply (drainThought() hands it over seperately)
internal fun blockCut(over: Int, block: Int): Int = if (over <= 0) 0 else (over + block - 1) / block * block

internal class ThinkStreamFilter {
    private val held = StringBuilder()
    private val thought = StringBuilder()
    private var inside = false

    fun push(chunk: String): String {
        val out = StringBuilder()
        for (char in chunk) {
            if (held.isEmpty() && char != '<') {
                (if (inside) thought else out).append(char)
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
                val into = if (inside) thought else out
                into.append(held, 0, held.length - 1)
                if (!restart) into.append(char)
                held.clear()
                if (restart) held.append(char)
            }
        }
        return out.toString()
    }

    fun finish(): String {
        val tail = if (inside) "" else held.toString()
        if (inside) thought.append(held)
        held.clear()
        return tail
    }

    fun drainThought(): String = thought.toString().also { thought.clear() }

    private companion object {
        const val OPEN = "<think>"
        const val CLOSE = "</think>"
    }
}
