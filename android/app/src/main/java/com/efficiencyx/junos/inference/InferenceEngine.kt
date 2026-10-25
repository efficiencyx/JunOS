package com.efficiencyx.junos.inference

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import java.io.Closeable

data class ChatMessage(
    val role: String,
    val content: String,
    val toolCalls: List<ParsedToolCall> = emptyList(),
    val toolName: String? = null,
)

data class ParsedToolCall(val name: String, val args: JsonObject)

sealed interface TurnEvent {
    data class Text(val text: String) : TurnEvent
    data class Thought(val text: String) : TurnEvent
    data class Call(val call: ParsedToolCall) : TurnEvent
}

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
    // where she runs, for the notification: "this phone", the PC's name
    val label: String
    val contextTokens: Int

    suspend fun ensureLoaded()
    fun generate(messages: List<ChatMessage>, maxTokens: Int = 768, temperature: Float = 0.4f): Flow<String>
    fun turn(
        messages: List<ChatMessage>,
        tools: List<String>,
        think: Boolean,
        maxTokens: Int = 768,
        temperature: Float = 0.4f,
        reasoning: String = "low",
    ): Flow<TurnEvent>
    fun cancel()
}
