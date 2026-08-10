package com.efficiencyx.junos.inference

import com.efficiencyx.junos.setup.ModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.Closeable

data class ChatMessage(val role: String, val content: String)

class LlamaEngine(private val models: ModelStore) : Closeable {
    private val bridge = NativeLlamaBridge()
    private val loadMutex = Mutex()
    @Volatile private var loaded = false

    suspend fun ensureLoaded() = loadMutex.withLock {
        if (loaded) return
        check(models.modelReady()) { "Jun model is not installed" }
        val cores = Runtime.getRuntime().availableProcessors()
        bridge.nativeLoad(models.modelFile.absolutePath, 4096, (cores - 2).coerceIn(2, 6))
        loaded = true
    }

    fun generate(messages: List<ChatMessage>, maxTokens: Int = 768, temperature: Float = 0.8f): Flow<String> = callbackFlow {
        val worker = launch(Dispatchers.Default) {
            runCatching {
                ensureLoaded()
                bridge.nativeGenerate(
                    messages.map { it.role }.toTypedArray(),
                    messages.map { it.content }.toTypedArray(),
                    maxTokens,
                    temperature,
                    object : NativeLlamaBridge.Callback {
                        override fun onToken(token: String) { trySend(token) }
                        override fun onComplete() { close() }
                        override fun onError(message: String) { close(IllegalStateException(message)) }
                    },
                )
            }.onFailure { close(it) }
        }
        awaitClose {
            bridge.nativeCancel()
            worker.cancel()
        }
    }

    fun cancel() = bridge.nativeCancel()

    override fun close() {
        if (loaded) bridge.nativeUnload()
        loaded = false
    }
}
