package com.efficiencyx.junos.inference

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import java.io.Closeable

data class ChatMessage(val role: String, val content: String)

sealed interface EngineState {
    data object Idle : EngineState
    data class Loading(val progress: Float) : EngineState
    data class Ready(val backend: String, val accelerator: String) : EngineState
    data class Prefill(val promptTokens: Int) : EngineState
    data class Generating(val tokens: Int, val tokensPerSecond: Float) : EngineState
    data class Failed(val message: String) : EngineState
}

interface InferenceEngine : Closeable {
    val state: StateFlow<EngineState>
    val lastStats: StateFlow<JsonObject?>

    suspend fun ensureLoaded()
    fun generate(messages: List<ChatMessage>, maxTokens: Int = 768, temperature: Float = 0.8f): Flow<String>
    fun cancel()
}
