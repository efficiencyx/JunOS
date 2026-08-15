package com.efficiencyx.junos.server

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.efficiencyx.junos.data.ConsolidationEntity
import com.efficiencyx.junos.data.ConversationEntity
import com.efficiencyx.junos.data.JunDatabase
import com.efficiencyx.junos.data.PreferenceEntity
import com.efficiencyx.junos.data.RelationshipEntity
import com.efficiencyx.junos.data.WardrobePresetEntity
import com.efficiencyx.junos.inference.ChatEngine
import com.efficiencyx.junos.inference.ChatRequest
import com.efficiencyx.junos.memory.MemoryStore
import com.efficiencyx.junos.setup.AssetRecovery
import com.efficiencyx.junos.voice.TtsRequest
import com.efficiencyx.junos.voice.VoiceEngine
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.httpMethod
import io.ktor.server.request.receiveChannel
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondFile
import io.ktor.server.response.respondRedirect
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

class LocalServer(
    private val context: Context,
    private val database: JunDatabase,
    private val memory: MemoryStore,
    private val chat: ChatEngine,
    private val voice: VoiceEngine,
    private val recovery: AssetRecovery,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val lifecycle = Mutex()
    private val session = randomToken()
    private val bootstrap = randomToken()
    private var stopServer: (() -> Unit)? = null
    private var currentUrl: String? = null

    suspend fun start(): String = lifecycle.withLock {
        currentUrl?.let { return@withLock it }
        val server = embeddedServer(CIO, host = LOOPBACK, port = 0) { module() }
        server.start(wait = false)
        val port = server.engine.resolvedConnectors().single().port
        stopServer = { server.stop(500, 2_000) }
        "http://$LOOPBACK:$port/__bootstrap?token=$bootstrap".also { currentUrl = it }
    }

    fun stop() {
        stopServer?.invoke()
        stopServer = null
        currentUrl = null
    }

    private fun Application.module() {
        routing {
            get("/__bootstrap") {
                if (call.request.queryParameters["token"] != bootstrap) return@get call.error(HttpStatusCode.Forbidden, "forbidden")
                call.response.cookies.append(
                    name = SESSION_COOKIE,
                    value = session,
                    path = "/",
                    httpOnly = true,
                    extensions = mapOf("SameSite" to "Strict"),
                )
                call.respondRedirect("/index.html")
            }

            get("/api/auth.php") {
                if (!call.authorized()) return@get
                when (call.request.queryParameters["action"]) {
                    "me" -> call.json(buildJsonObject {
                        // whoever's holding the phone owns the install, so the
                        // dev panel and the memory tools stay unlocked here
                        put("user", buildJsonObject { put("id", 1); put("email", "local@jun.os"); put("role", "admin") })
                    })
                    else -> call.error(HttpStatusCode.BadRequest, "unknown_action")
                }
            }
            post("/api/auth.php") {
                if (!call.authorized()) return@post
                call.error(HttpStatusCode.NotFound, "local_profile_only")
            }

            get("/api/models.php") {
                if (!call.authorized()) return@get
                call.json(buildJsonObject {
                    put("models", buildJsonArray { add(JsonPrimitive(MODEL_ID)) })
                    put("provider", "litertlm-android")
                    put("default_model", MODEL_ID)
                })
            }

            post("/api/chat.php") {
                if (!call.authorized()) return@post
                val request = runCatching { json.decodeFromString<ChatRequest>(call.receiveLimitedText(CHAT_BODY_LIMIT)) }
                    .getOrElse { return@post call.error(HttpStatusCode.BadRequest, "invalid_request") }
                call.response.header(HttpHeaders.CacheControl, "no-cache, no-transform")
                call.response.header("X-Accel-Buffering", "no")
                call.respondTextWriter(ContentType.Text.EventStream) {
                    val finished = AtomicBoolean(false)
                    suspend fun event(value: String) {
                        write("data: "); write(value); write("\n\n"); flush()
                    }
                    try {
                        chat.stream(request) { event(it.toString()) }
                        event("[DONE]")
                        finished.set(true)
                    } catch (error: Throwable) {
                        Log.e(TAG, "chat stream failed", error)
                        val code = error.message?.take(120)?.replace(Regex("[^a-zA-Z0-9_. -]"), "_") ?: "generation_failed"
                        event(buildJsonObject { put("error", code) }.toString())
                        event("[DONE]")
                    } finally {
                        if (!finished.get()) chat.cancel()
                    }
                }
            }

            get("/api/conversations.php") { if (call.authorized()) conversations() }
            post("/api/conversations.php") { if (call.authorized()) conversations() }
            delete("/api/conversations.php") { if (call.authorized()) conversations() }

            get("/api/prefs.php") {
                if (!call.authorized()) return@get
                val stored = database.dao().preferences()?.data
                call.json(stored?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() } ?: JsonObject(emptyMap()))
            }
            put("/api/prefs.php") {
                if (!call.authorized()) return@put
                val body = runCatching { json.parseToJsonElement(call.receiveLimitedText(16 * 1024)).jsonObject }
                    .getOrElse { return@put call.error(HttpStatusCode.BadRequest, "invalid_request") }
                if (body.values.any { it !is JsonPrimitive || !it.isString }) return@put call.error(HttpStatusCode.BadRequest, "invalid_request")
                database.dao().putPreferences(PreferenceEntity(data = body.toString()))
                call.ok()
            }

            get("/api/relationship.php") { if (call.authorized()) relationship() }
            put("/api/relationship.php") { if (call.authorized()) relationship() }

            get("/api/wardrobe.php") { if (call.authorized()) wardrobe() }
            post("/api/wardrobe.php") { if (call.authorized()) wardrobe() }
            delete("/api/wardrobe.php") { if (call.authorized()) wardrobe() }

            get("/api/memory.php") {
                if (!call.authorized()) return@get
                call.respondText(json.encodeToString(memory.snapshot()), ContentType.Application.Json)
            }
            post("/api/memory.php") {
                if (!call.authorized()) return@post
                val body = call.jsonBody(8 * 1024) ?: return@post
                val text = body["memory"]?.jsonPrimitive?.content.orEmpty()
                val category = body["category"]?.jsonPrimitive?.content ?: "events"
                val note = runCatching { memory.add(category, text) }
                    .getOrElse { return@post call.error(HttpStatusCode.BadRequest, "invalid_memory") }
                call.respondText(json.encodeToString(note), ContentType.Application.Json)
            }
            delete("/api/memory.php") {
                if (!call.authorized()) return@delete
                val body = call.jsonBody(8 * 1024) ?: return@delete
                if (body["all"]?.jsonPrimitive?.content == "true") memory.clear()
                else {
                    val id = body["id"]?.jsonPrimitive?.content.orEmpty()
                    val deleted = runCatching { memory.delete(id) }.getOrDefault(false)
                    if (!deleted) return@delete call.error(HttpStatusCode.NotFound, "memory_not_found")
                }
                call.ok()
            }

            get("/api/consolidate.php") { if (call.authorized()) consolidate() }
            post("/api/consolidate.php") { if (call.authorized()) consolidate() }

            get("/api/stats.php") {
                if (!call.authorized()) return@get
                val info = ActivityManager.MemoryInfo().also {
                    (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it)
                }
                call.json(buildJsonObject {
                    put("models", JsonArray(emptyList())); put("vram_bytes", 0); put("ram_model_bytes", 0)
                    put("host", buildJsonObject { put("total", info.totalMem); put("avail", info.availMem); put("used", info.totalMem - info.availMem) })
                })
            }

            get("/api/karaoke.php") {
                if (!call.authorized()) return@get
                call.json(buildJsonObject { put("ok", false); put("available", false); put("error", "unavailable_on_android") })
            }
            get("/api/stt.php") {
                if (!call.authorized()) return@get
                call.json(buildJsonObject { put("ok", true); put("stt", voice.available) })
            }
            post("/api/stt.php") {
                if (!call.authorized()) return@post
                if (call.request.queryParameters["action"] != "stt") return@post call.error(HttpStatusCode.BadRequest, "unknown_action")
                val wav = call.receiveLimitedBytes(4 * 1024 * 1024)
                val text = runCatching { voice.transcribe(wav) }
                    .getOrElse { return@post call.error(HttpStatusCode.ServiceUnavailable, it.message ?: "stt_unavailable") }
                call.json(buildJsonObject { put("text", text) })
            }
            get("/api/tts.php") {
                if (!call.authorized()) return@get
                if (call.request.queryParameters["action"] != "voices") return@get call.error(HttpStatusCode.BadRequest, "unknown_action")
                call.json(voice.voices())
            }
            post("/api/tts.php") {
                if (!call.authorized()) return@post
                when (call.request.queryParameters["action"]) {
                    "warm" -> { voice.warm(); call.ok() }
                    "tts" -> {
                        val request = runCatching { json.decodeFromString<TtsRequest>(call.receiveLimitedText(8 * 1024)) }
                            .getOrElse { return@post call.error(HttpStatusCode.BadRequest, "invalid_request") }
                        val wav = runCatching { voice.synthesize(request) }
                            .getOrElse { return@post call.error(HttpStatusCode.ServiceUnavailable, it.message ?: "tts_unavailable") }
                        call.respondBytes(wav, ContentType.parse("audio/wav"))
                    }
                    else -> call.error(HttpStatusCode.BadRequest, "unknown_action")
                }
            }

            get("/{path...}") {
                if (!call.authorized()) return@get
                val path = call.parameters.getAll("path")?.joinToString("/").orEmpty().ifBlank { "index.html" }
                if (!safePath(path)) return@get call.error(HttpStatusCode.BadRequest, "invalid_path")
                if (path.startsWith("assets/")) {
                    val recovered = recovery.assetFile(path.removePrefix("assets/"))
                        ?: return@get call.error(HttpStatusCode.NotFound, "not_found")
                    return@get call.respondFile(recovered)
                }
                val bytes = runCatching { context.assets.open(path).use { it.readBytes() } }.getOrNull()
                    ?: return@get call.error(HttpStatusCode.NotFound, "not_found")
                call.response.header("Content-Security-Policy", CSP)
                call.response.header("X-Content-Type-Options", "nosniff")
                call.respondBytes(bytes, contentType(path))
            }
        }
    }

    private suspend fun io.ktor.server.routing.RoutingContext.conversations() {
        val dao = database.dao()
        val action = call.request.queryParameters["action"].orEmpty()
        val id = call.request.queryParameters["id"]?.toLongOrNull()
        when (action) {
            "list" -> {
                if (call.request.httpMethod != HttpMethod.Get) return call.error(HttpStatusCode.MethodNotAllowed, "method_not_allowed")
                call.json(buildJsonArray { dao.conversations().forEach { value -> add(buildJsonObject {
                    put("id", value.id); value.title?.let { put("title", it) }; put("created_at", value.createdAt); put("updated_at", value.updatedAt)
                }) } })
            }
            "create" -> {
                if (call.request.httpMethod != HttpMethod.Post) return call.error(HttpStatusCode.MethodNotAllowed, "method_not_allowed")
                val now = now(); call.json(buildJsonObject { put("id", dao.insertConversation(ConversationEntity(createdAt = now, updatedAt = now))) })
            }
            "messages" -> {
                if (id == null || dao.conversation(id) == null) return call.error(HttpStatusCode.NotFound, "not_found")
                call.json(buildJsonArray { dao.messages(id).forEach { add(buildJsonObject {
                    put("role", it.role); put("content", it.content); put("created_at", it.createdAt)
                }) } })
            }
            "rename" -> {
                if (id == null) return call.error(HttpStatusCode.BadRequest, "invalid_request")
                val title = call.jsonBody(4 * 1024)?.get("title")?.jsonPrimitive?.content?.trim()?.take(120).orEmpty()
                if (title.isBlank() || dao.renameConversation(id, title, now()) == 0) return call.error(HttpStatusCode.NotFound, "not_found")
                call.ok()
            }
            "delete" -> {
                if (id == null || dao.deleteConversation(id) == 0) return call.error(HttpStatusCode.NotFound, "not_found")
                call.ok()
            }
            "delete_last_assistant" -> {
                if (id == null || dao.conversation(id) == null) return call.error(HttpStatusCode.NotFound, "not_found")
                dao.deleteLastAssistant(id); call.ok()
            }
            "compact" -> {
                if (id == null) return call.error(HttpStatusCode.BadRequest, "invalid_request")
                val conversation = dao.conversation(id) ?: return call.error(HttpStatusCode.NotFound, "not_found")
                val tail = dao.messagesAfter(id, conversation.summaryUptoId)
                if (tail.size <= 6 || tail.sumOf { it.content.length } <= 8_192) return call.json(buildJsonObject { put("compacted", false) })
                val fold = tail.dropLast(6)
                val summary = chat.summarize(conversation.summary.orEmpty(), fold)
                dao.updateSummary(id, summary, fold.last().id)
                call.json(buildJsonObject { put("compacted", true); put("upto_id", fold.last().id) })
            }
            else -> call.error(HttpStatusCode.BadRequest, "invalid_action")
        }
    }

    private suspend fun io.ktor.server.routing.RoutingContext.relationship() {
        val dao = database.dao(); dao.ensureDefaults(now())
        if (call.request.httpMethod == HttpMethod.Put) {
            val body = call.jsonBody(1024) ?: return
            val values = listOf("affection", "trust", "tension").map { body[it]?.jsonPrimitive?.intOrNull }
            if (values.any { it == null }) return call.error(HttpStatusCode.BadRequest, "invalid_request")
            dao.putRelationship(RelationshipEntity(affection = values[0]!!.coerceIn(0, 100), trust = values[1]!!.coerceIn(0, 100), tension = values[2]!!.coerceIn(0, 100), updatedAt = now()))
        }
        val value = dao.relationship()!!
        call.json(buildJsonObject { put("affection", value.affection); put("trust", value.trust); put("tension", value.tension); put("updated_at", value.updatedAt) })
    }

    private suspend fun io.ktor.server.routing.RoutingContext.wardrobe() {
        val dao = database.dao()
        when (call.request.httpMethod) {
            HttpMethod.Get -> call.json(buildJsonArray { dao.wardrobePresets().forEach { preset -> add(buildJsonObject {
                put("id", preset.id); put("name", preset.name); put("updated_at", preset.updatedAt)
                put("data", runCatching { json.parseToJsonElement(preset.data) }.getOrDefault(JsonObject(emptyMap())))
            }) } })
            HttpMethod.Post -> {
                val body = call.jsonBody(64 * 1024) ?: return
                val name = body["name"]?.jsonPrimitive?.content?.trim().orEmpty()
                val data = body["data"] as? JsonObject
                if (name.isBlank() || name.length > 60 || data == null) return call.error(HttpStatusCode.BadRequest, "invalid_request")
                if (dao.wardrobePreset(name) == null && dao.wardrobePresetCount() >= 50) return call.error(HttpStatusCode.BadRequest, "too_many_presets")
                val existing = dao.wardrobePreset(name)
                val id = dao.putWardrobePreset(WardrobePresetEntity(id = existing?.id ?: 0, name = name, data = data.toString(), updatedAt = now()))
                call.json(buildJsonObject { put("id", if (existing != null) existing.id else id); put("name", name) })
            }
            HttpMethod.Delete -> {
                val id = call.request.queryParameters["id"]?.toLongOrNull() ?: return call.error(HttpStatusCode.BadRequest, "invalid_request")
                dao.deleteWardrobePreset(id); call.ok()
            }
            else -> call.error(HttpStatusCode.MethodNotAllowed, "method_not_allowed")
        }
    }

    private suspend fun io.ktor.server.routing.RoutingContext.consolidate() {
        val dao = database.dao(); dao.ensureDefaults(now())
        when (call.request.queryParameters["action"]) {
            "status" -> {
                val state = dao.consolidation()!!
                call.json(buildJsonObject {
                    put("enabled", state.enabled); put("running", false); put("pending", 0); put("last_activity", state.lastActivity)
                    if (state.lastRun > 0) put("last", buildJsonObject { put("at", state.lastRun); put("status", state.lastStatus); put("notes", state.lastNoteCount) })
                })
            }
            "welcome" -> call.json(buildJsonObject { put("messages", JsonArray(emptyList())); put("away", 0); put("tier", "none") })
            "activity" -> {
                val current = dao.consolidation() ?: ConsolidationEntity()
                dao.putConsolidation(current.copy(lastActivity = now(), enabled = call.request.queryParameters["enabled"] != "0")); call.ok()
            }
            else -> call.json(buildJsonObject { put("ok", true); put("notes", 0) })
        }
    }

    private suspend fun io.ktor.server.application.ApplicationCall.authorized(): Boolean {
        // localHost turns into "localhost" on android. localAddress
        // keeps the literal IP the server actually bound.
        if (request.local.localAddress != LOOPBACK || request.cookies[SESSION_COOKIE] != session) {
            error(HttpStatusCode.Forbidden, "forbidden")
            return false
        }
        return true
    }

    private suspend fun io.ktor.server.application.ApplicationCall.jsonBody(limit: Int): JsonObject? =
        runCatching { json.parseToJsonElement(receiveLimitedText(limit)).jsonObject }.getOrElse {
            error(HttpStatusCode.BadRequest, "invalid_request"); null
        }

    private suspend fun io.ktor.server.application.ApplicationCall.receiveLimitedText(limit: Int): String =
        receiveLimitedBytes(limit).toString(Charsets.UTF_8)

    private suspend fun io.ktor.server.application.ApplicationCall.receiveLimitedBytes(limit: Int): ByteArray {
        val channel = receiveChannel()
        val output = ByteArrayOutputStream(minOf(limit, 64 * 1024))
        val buffer = ByteArray(64 * 1024)
        while (!channel.isClosedForRead) {
            val read = channel.readAvailable(buffer)
            if (read < 0) break
            if (output.size() + read > limit) error("request_too_large")
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private suspend fun io.ktor.server.application.ApplicationCall.json(value: JsonElement, status: HttpStatusCode = HttpStatusCode.OK) {
        respondText(value.toString(), ContentType.Application.Json, status)
    }

    private suspend fun io.ktor.server.application.ApplicationCall.ok() = json(buildJsonObject { put("ok", true) })

    private suspend fun io.ktor.server.application.ApplicationCall.error(status: HttpStatusCode, code: String) {
        json(buildJsonObject { put("error", code) }, status)
    }

    private fun safePath(path: String) = path.isNotBlank() && path.length <= 512 && '\\' !in path &&
        path.split('/').none { it.isBlank() || it == "." || it == ".." }

    private fun contentType(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> ContentType.Text.Html
        "css" -> ContentType.Text.CSS
        "js", "mjs" -> ContentType.parse("text/javascript; charset=utf-8")
        "json", "map" -> ContentType.Application.Json
        "png" -> ContentType.Image.PNG
        "jpg", "jpeg" -> ContentType.Image.JPEG
        "svg" -> ContentType.Image.SVG
        "webp" -> ContentType.parse("image/webp")
        "wav" -> ContentType.parse("audio/wav")
        "mp3" -> ContentType.Audio.MPEG
        "webm" -> ContentType.parse("video/webm")
        "wasm" -> ContentType.Application.Wasm
        else -> ContentType.Application.OctetStream
    }

    private fun randomToken(): String = ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
    private fun now() = System.currentTimeMillis() / 1000

    companion object {
        private const val TAG = "JunServer"
        private const val LOOPBACK = "127.0.0.1"
        private const val SESSION_COOKIE = "omega_session"
        private const val MODEL_ID = "jun-e2b-q4_k_m"
        private const val CHAT_BODY_LIMIT = 1024 * 1024
        private const val CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"
    }
}
