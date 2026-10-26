package com.efficiencyx.junos.inference

import android.util.Log
import com.efficiencyx.junos.setup.ModelStore
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.InputData
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.ResponseCallback
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.google.ai.edge.litertlm.ToolCall
import com.google.ai.edge.litertlm.tool
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "LiteRtEngine"

class LiteRtEngine(
    private val models: ModelStore,
    private val backend: Backend = Backend.GPU(),
    override val contextTokens: Int = 8192,
) : InferenceEngine {
    override val label = "this phone"
    private val loadMutex = Mutex()
    private val _state = MutableStateFlow<EngineState>(EngineState.Idle)
    private val _lastStats = MutableStateFlow<JsonObject?>(null)
    @Volatile private var engine: Engine? = null
    @Volatile private var stopActive: (() -> Unit)? = null
    private var prefixCache: PrefixCache? = null
    private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override val state: StateFlow<EngineState> = _state.asStateFlow()
    override val lastStats: StateFlow<JsonObject?> = _lastStats.asStateFlow()

    override suspend fun ensureLoaded(): Unit = loadMutex.withLock {
        if (engine != null) return
        check(models.litertReady()) { "Jun LiteRT model is not installed" }
        _state.value = EngineState.Loading(0f)
        try {
            // initialize() compiles GPU kernels the first time.
            // cacheDir stops later launches redoing all of it.
            val created = Engine(
                EngineConfig(
                    models.litertModelFile.absolutePath,
                    backend,
                    null,
                    null,
                    contextTokens,
                    null,
                    models.litertCacheDir.absolutePath,
                )
            )
            created.initialize()
            engine = created
        } catch (error: Throwable) {
            _state.value = EngineState.Failed(error.message ?: "LiteRT engine init failed")
            throw error
        }
        _state.value = EngineState.Ready("litert-lm", backend.name)
    }

    override fun generate(messages: List<ChatMessage>, maxTokens: Int, temperature: Float): Flow<String> =
        stream(messages, emptyList(), null, maxTokens, temperature)
            .mapNotNull { (it as? TurnEvent.Text)?.text }

    override fun turn(
        messages: List<ChatMessage>,
        tools: List<String>,
        think: Boolean,
        maxTokens: Int,
        temperature: Float,
        reasoning: String,
    ): Flow<TurnEvent> = stream(messages, tools, ThinkingConfig(think), maxTokens, temperature)

    private fun stream(
        messages: List<ChatMessage>,
        tools: List<String>,
        thinking: ThinkingConfig?,
        maxTokens: Int,
        temperature: Float,
    ): Flow<TurnEvent> = callbackFlow {
        ensureLoaded()
        val engine = engine ?: error("LiteRT engine is not loaded")
        val system = messages.firstOrNull { it.role == "system" }?.content
        val rest = messages.drop(if (system != null) 1 else 0)
        _state.value = EngineState.Prefill(messages.sumOf { it.content.length } / 4)

        val cached = if (thinking != null && tools.isNotEmpty() && PrefixCache.supported) {
            runCatching { prefixCache(engine).open(system, rest, tools, thinking.enableThinking, temperature) }
                .onFailure { Log.w(TAG, "prefix cache off for this turn", it) }
                .getOrNull()
        } else null
        if (cached != null) sessionTurn(cached, maxTokens)
        else conversationTurn(engine, system, rest, tools, thinking, maxTokens, temperature)
    }.flowOn(Dispatchers.Default)

    private suspend fun ProducerScope<TurnEvent>.conversationTurn(
        engine: Engine,
        system: String?,
        rest: List<ChatMessage>,
        tools: List<String>,
        thinking: ThinkingConfig?,
        maxTokens: Int,
        temperature: Float,
    ) {
        // ChatEngine rebuilds the transcript every turn and puts the
        // live context in the last message. a long-lived Conversation
        // would carry the history TWICE, so every turn gets a fresh
        // one. the prompt template still comes from .litertlm.
        val last = rest.lastOrNull() ?: error("no message to send")

        // automatic calling OFF. ChatEngine runs the tool itself, it
        // has to stream status events and outfit changes to the page,
        // so the call comes back here as a ToolCall and execute() is
        // never reached
        val conversation = engine.createConversation(
            ConversationConfig(
                systemInstruction = system?.let { Contents.of(it) },
                initialMessages = rest.dropLast(1).map { it.toLiteRtMessage() },
                tools = tools.map { schema -> tool(DeclaredTool(schema)) },
                samplerConfig = SamplerConfig(64, 0.95, temperature.toDouble(), 0),
                automaticToolCalling = false,
                maxOutputToken = maxTokens,
                thinkingConfig = thinking,
            )
        )
        stopActive = { conversation.close() }

        val started = System.nanoTime()
        var emitted = 0

        // deliberately NOT litertlm's Flow overload. it was built
        // against coroutines 1.9.0, where SendChannel.close$default
        // has a different ABI from this app's 1.10.1. mix them and
        // you get NoSuchMethodError on the first onDone. the plain
        // callback keeps the channel on our side of that boundary.
        conversation.sendMessageAsync(
            last.toLiteRtMessage(),
            object : MessageCallback {
                override fun onMessage(message: Message) {
                    val text = message.text()
                    if (text.isNotEmpty()) {
                        emitted++
                        trySend(TurnEvent.Text(text))
                    }
                    message.toolCalls.forEach { call ->
                        trySend(TurnEvent.Call(ParsedToolCall(call.name, call.arguments.toJsonObject())))
                    }
                }

                override fun onDone() {
                    close()
                }

                override fun onError(error: Throwable) {
                    close(error)
                }
            },
        )

        awaitClose {
            stopActive = null
            runCatching { conversation.close() }
            finishStats(started, emitted)
        }
    }

    private suspend fun ProducerScope<TurnEvent>.sessionTurn(turn: PrefixCache.Turn, maxTokens: Int) {
        val session = turn.session
        val parser = RawTurnParser()
        val started = System.nanoTime()
        var emitted = 0
        val stopping = AtomicBoolean(false)
        fun stop() {
            if (stopping.compareAndSet(false, true)) runCatching { session.cancelProcess() }
        }
        stopActive = ::stop

        val pieces = prefillPieces(turn.prompt)
        pieces.dropLast(1).forEach { session.runPrefill(listOf(InputData.Text(it))) }
        // a raw Session has no maxOutputToken, the cap is ours
        session.generateContentStream(
            listOf(InputData.Text(pieces.last())),
            object : ResponseCallback {
                override fun onNext(response: String) {
                    emitted++
                    parser.push(response).forEach { trySend(it) }
                    if (parser.stopped || emitted >= maxTokens) stop()
                }

                override fun onDone() {
                    parser.finish().forEach { trySend(it) }
                    close()
                }

                override fun onError(throwable: Throwable) {
                    if (!stopping.get()) return run { close(throwable) }
                    parser.finish().forEach { trySend(it) }
                    close()
                }
            },
        )

        awaitClose {
            stopActive = null
            runCatching { session.close() }
            finishStats(started, emitted)
        }
    }

    override fun warm(messages: List<ChatMessage>, tools: List<String>, think: Boolean, temperature: Float) {
        val engine = engine ?: return
        if (!PrefixCache.supported) return
        val system = messages.firstOrNull { it.role == "system" }?.content
        val rest = messages.drop(if (system != null) 1 else 0)
        background.launch {
            runCatching { prefixCache(engine).warm(system, rest, tools, think, temperature) }
                .onFailure { Log.w(TAG, "warm failed", it) }
        }
    }

    @Synchronized
    private fun prefixCache(engine: Engine): PrefixCache =
        prefixCache ?: PrefixCache(engine).also { prefixCache = it }

    private fun finishStats(started: Long, emitted: Int) {
        _lastStats.value = buildJsonObject {
            put("eval_count", emitted)
            put("eval_ms", (System.nanoTime() - started) / 1_000_000)
            put("prompt_eval_count", 0)
        }
        _state.value = EngineState.Ready("litert-lm", backend.name)
    }

    override fun cancel() {
        stopActive?.let { runCatching { it() } }
        stopActive = null
    }

    override fun close() {
        cancel()
        background.cancel()
        prefixCache?.close()
        prefixCache = null
        engine?.let { runCatching { it.close() } }
        engine = null
        _state.value = EngineState.Idle
    }
}

internal class DeclaredTool(private val schema: String) : OpenApiTool {
    override fun getToolDescriptionJsonString(): String = toolDescription(schema)
    override fun execute(paramsJsonString: String): String = "{}"
}

// ToolManager adds the {"type":"function"} wrapper ITSELF. wrap it twice
// and createConversation dies with Failed to parse field "name"
internal fun toolDescription(schema: String): String =
    Json.parseToJsonElement(schema).jsonObject["function"]?.toString() ?: schema

// v8 trained on the real round trip, the model turn carrying the
// call and a tool turn carrying the result, not v7's "(Tool
// result, ...)" user line
internal fun ChatMessage.toLiteRtMessage(): Message = when {
    role == "assistant" && toolCalls.isNotEmpty() -> Message.model(
        if (content.isBlank()) Contents.of(emptyList()) else Contents.of(content),
        toolCalls.map { ToolCall(it.name, it.args.toPlain()) },
        emptyMap(),
    )
    role == "assistant" -> Message.model(content)
    role == "system" -> Message.system(content)
    role == "tool" -> Message.tool(Contents.of(Content.ToolResponse(toolName ?: "unknown", parseResult(content))))
    else -> Message.user(content)
}

private fun parseResult(raw: String): Any =
    runCatching { Json.parseToJsonElement(raw).toPlain() }.getOrNull() ?: raw

private fun JsonObject.toPlain(): Map<String, Any?> = mapValues { (_, value) -> value.toPlain() }

private fun JsonElement.toPlain(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> toPlain()
    is JsonArray -> map { it.toPlain() }
    is JsonPrimitive -> if (isString) content else booleanOrNull ?: longOrNull ?: doubleOrNull ?: content
}

private fun Map<String, Any?>.toJsonObject(): JsonObject = JsonObject(mapValues { (_, value) -> value.toJsonElement() })

private fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJsonElement() })
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    else -> JsonPrimitive(toString())
}

private fun Message.text(): String = contents.contents
    .filterIsInstance<Content.Text>()
    .joinToString("") { it.text }
