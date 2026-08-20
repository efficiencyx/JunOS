package com.efficiencyx.junos.inference

import com.efficiencyx.junos.setup.ModelStore
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class LiteRtEngine(
    private val models: ModelStore,
    private val backend: Backend = Backend.GPU(),
    private val contextTokens: Int = 4096,
) : InferenceEngine {
    private val loadMutex = Mutex()
    private val _state = MutableStateFlow<EngineState>(EngineState.Idle)
    private val _lastStats = MutableStateFlow<JsonObject?>(null)
    @Volatile private var engine: Engine? = null
    @Volatile private var active: Conversation? = null

    override val state: StateFlow<EngineState> = _state.asStateFlow()
    override val lastStats: StateFlow<JsonObject?> = _lastStats.asStateFlow()

    override suspend fun ensureLoaded() = loadMutex.withLock {
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

    override fun generate(messages: List<ChatMessage>, maxTokens: Int, temperature: Float): Flow<String> = callbackFlow {
        ensureLoaded()
        val engine = engine ?: error("LiteRT engine is not loaded")

        // ChatEngine rebuilds the transcript every turn and puts the
        // live context in the last message. a long-lived Conversation
        // would carry the history TWICE, so every turn gets a fresh
        // one. the prompt template still comes from .litertlm.
        val system = messages.firstOrNull { it.role == "system" }?.content
        val rest = messages.drop(if (system != null) 1 else 0)
        val last = rest.lastOrNull() ?: error("no message to send")

        val conversation = engine.createConversation(
            ConversationConfig(
                systemInstruction = system?.let { Contents.of(it) },
                initialMessages = rest.dropLast(1).map { it.toLiteRtMessage() },
                samplerConfig = SamplerConfig(64, 0.95, temperature.toDouble(), 0),
                maxOutputToken = maxTokens,
            )
        )
        active = conversation
        _state.value = EngineState.Prefill(messages.sumOf { it.content.length } / 4)

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
                        trySend(text)
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
            active = null
            runCatching { conversation.close() }
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            _lastStats.value = buildJsonObject {
                put("eval_count", emitted)
                put("eval_ms", elapsedMs)
                put("prompt_eval_count", 0)
            }
            _state.value = EngineState.Ready("litert-lm", backend.name)
        }
    }.flowOn(Dispatchers.Default)

    override fun cancel() {
        active?.let { runCatching { it.close() } }
        active = null
    }

    override fun close() {
        cancel()
        engine?.let { runCatching { it.close() } }
        engine = null
        _state.value = EngineState.Idle
    }
}

private fun ChatMessage.toLiteRtMessage(): Message = when (role) {
    "assistant" -> Message.model(Contents.of(content))
    "system" -> Message.system(content)
    "tool" -> Message.tool(Contents.of(content))
    else -> Message.user(content)
}

private fun Message.text(): String = contents.contents
    .filterIsInstance<Content.Text>()
    .joinToString("") { it.text }
