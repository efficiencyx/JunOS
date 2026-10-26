package com.efficiencyx.junos

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.efficiencyx.junos.inference.ChatEngine
import com.efficiencyx.junos.inference.ChatMessage
import com.efficiencyx.junos.inference.LiteRtEngine
import com.efficiencyx.junos.inference.PrefixCache
import com.efficiencyx.junos.inference.TurnEvent
import com.efficiencyx.junos.setup.ModelStore
import com.google.ai.edge.litertlm.Backend
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

// a chat the way ChatEngine drives LiteRtEngine: live context on the
// last user turn, a tool round, think flipping. logs time to first
// event per turn. with clone() around (-PlitertlmLocal) the prefix
// cache should make every turn after the first one fast.
@RunWith(AndroidJUnit4::class)
class LiteRtTurnsProbeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun chat() = runBlocking {
        val models = ModelStore(context)
        assumeTrue("no jun.litertlm in files/models", models.litertReady())
        val backend = if (InstrumentationRegistry.getArguments().getString("backend") == "cpu") Backend.CPU() else Backend.GPU()
        val engine = LiteRtEngine(models, backend)
        engine.ensureLoaded()
        Log.i(TAG, "cache supported=${PrefixCache.supported}")
        val system = context.assets.open("system_prompt.txt").bufferedReader().use { it.readText() }
            .replace(Regex("(?m)^<!--/?tools-->\\R"), "")
        val history = mutableListOf(ChatMessage("system", system))
        val turns = listOf(
            "hey, I'm home" to false,
            "you sound tired. long day?" to false,
            "put on your witch hat for me?" to false,
            "it suits you. what do you want for dinner?" to true,
            "ok, I'll cook. any requests?" to false,
        )
        try {
            for ((i, pair) in turns.withIndex()) {
                val (said, think) = pair
                val messages = (history + ChatMessage("user", "$said\n\n$LIVE\n\n<think:low>")).toMutableList()
                var reply = ""
                for (round in 0 until 2) {
                    val (ms, events) = timedTurn(engine, messages, think)
                    val text = events.filterIsInstance<TurnEvent.Text>().joinToString("") { it.text }
                    val calls = events.filterIsInstance<TurnEvent.Call>().map { it.call }
                    val thought = events.filterIsInstance<TurnEvent.Thought>().sumOf { it.text.length }
                    Log.i(TAG, "turn$i.$round think=$think first=${ms}ms thought=${thought}ch calls=${calls.map { it.name }} reply=[${text.replace('\n', ' ')}]")
                    reply += text
                    if (calls.isEmpty()) break
                    messages += ChatMessage("assistant", text, toolCalls = calls)
                    calls.forEach { messages += ChatMessage("tool", """{"wearing":["witch_hat","hoodie","skirt"]}""", toolName = it.name) }
                }
                history += ChatMessage("user", said)
                engine.warm(history, ChatEngine.TOOL_SCHEMAS, think)
                history += ChatMessage("assistant", reply.trim().ifEmpty { "..." })
                // him reading her reply
                delay(10_000)
            }
        } finally {
            engine.close()
        }
    }

    private suspend fun timedTurn(engine: LiteRtEngine, messages: List<ChatMessage>, think: Boolean): Pair<Long, List<TurnEvent>> {
        val start = System.nanoTime()
        var first = -1L
        val events = mutableListOf<TurnEvent>()
        engine.turn(messages, ChatEngine.TOOL_SCHEMAS, think, maxTokens = 160).collect {
            if (first < 0) first = (System.nanoTime() - start) / 1_000_000
            events += it
        }
        return first to events
    }

    companion object {
        private const val TAG = "LiteRtTurnsProbe"
        private const val LIVE = "# Live context\nTime: Monday 21:40. Mood: relaxed. Affection 40, trust 35, tension 10."
    }
}
