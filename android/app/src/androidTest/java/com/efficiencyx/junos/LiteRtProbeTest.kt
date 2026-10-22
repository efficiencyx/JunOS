package com.efficiencyx.junos

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.efficiencyx.junos.inference.ChatMessage
import com.efficiencyx.junos.inference.LiteRtEngine
import com.efficiencyx.junos.setup.ModelStore
import com.google.ai.edge.litertlm.Backend
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.AfterClass
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// loads whatever jun.litertlm is already in the app's files/models
// and times a few replies. no model there = skipped, not failed.
// pass -e backend cpu for the cpu side, the default is gpu.
@RunWith(AndroidJUnit4::class)
class LiteRtProbeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun load(): Unit = runBlocking {
        val models = ModelStore(context)
        assumeTrue("no jun.litertlm in files/models", models.litertReady())
        if (shared == null) {
            val wanted = InstrumentationRegistry.getArguments().getString("backend") ?: "gpu"
            val engine = LiteRtEngine(models, if (wanted == "cpu") Backend.CPU() else Backend.GPU())
            val ms = timed { engine.ensureLoaded() }
            Log.i(TAG, "backend=$wanted load=${ms}ms state=${engine.state.value}")
            shared = engine
        }
    }

    @Test
    fun shortReply() = runBlocking {
        val reply = reply("short", listOf(ChatMessage("user", "hey, how was your day?")))
        check(reply.isNotBlank()) { "empty reply" }
    }

    @Test
    fun persona() = runBlocking {
        val system = context.assets.open("system_prompt.txt").bufferedReader().use { it.readText() }
            .replace(Regex("(?m)^<!--/?tools-->\\R"), "")
        val reply = reply(
            "persona",
            listOf(
                ChatMessage("system", system),
                ChatMessage("user", "morning. did you sleep at all?"),
                ChatMessage("assistant", "barely. the neighbours were at it again."),
                ChatMessage("user", "want to grab breakfast somewhere?"),
            ),
        )
        check(reply.isNotBlank()) { "empty reply" }
    }

    @Test
    fun backToBack() = runBlocking {
        repeat(3) { i -> reply("turn$i", listOf(ChatMessage("user", "say a number between 1 and 10, just the number"))) }
    }

    @Test
    fun cancelMidReply(): Unit = runBlocking {
        val engine = shared!!
        val partial = engine.generate(listOf(ChatMessage("user", "tell me a long story about a cat")), maxTokens = 256)
            .take(5).toList()
        Log.i(TAG, "cancel: got ${partial.size} chunks then stopped, state=${engine.state.value}")
        reply("after-cancel", listOf(ChatMessage("user", "still there?")))
    }

    @Test
    fun streamVsSync() {
        val models = ModelStore(context)
        shared?.close()
        shared = null
        val engine = com.google.ai.edge.litertlm.Engine(
            com.google.ai.edge.litertlm.EngineConfig(
                models.litertModelFile.absolutePath, Backend.CPU(), null, null, 4096, null,
                models.litertCacheDir.absolutePath,
            )
        )
        engine.initialize()
        try {
            val greedy = com.google.ai.edge.litertlm.ConversationConfig(
                samplerConfig = com.google.ai.edge.litertlm.SamplerConfig(1, 1.0, 1.0, 0),
                maxOutputToken = 64,
            )
            val prompt = "hey, how was your day?"
            val sync = engine.createConversation(greedy).use { c ->
                c.sendMessage(com.google.ai.edge.litertlm.Message.user(prompt)).contents.contents
                    .filterIsInstance<com.google.ai.edge.litertlm.Content.Text>().joinToString("") { it.text }
            }
            val streamed = StringBuilder()
            val done = java.util.concurrent.CountDownLatch(1)
            engine.createConversation(greedy).use { c ->
                c.sendMessageAsync(com.google.ai.edge.litertlm.Message.user(prompt), object : com.google.ai.edge.litertlm.MessageCallback {
                    override fun onMessage(message: com.google.ai.edge.litertlm.Message) {
                        streamed.append(message.contents.contents
                            .filterIsInstance<com.google.ai.edge.litertlm.Content.Text>().joinToString("") { it.text })
                    }
                    override fun onDone() { done.countDown() }
                    override fun onError(error: Throwable) { Log.e(TAG, "stream error", error); done.countDown() }
                })
                done.await()
            }
            Log.i(TAG, "sync    : [${sync.replace('\n', '|')}]")
            Log.i(TAG, "streamed: [${streamed.toString().replace('\n', '|')}]")
        } finally {
            engine.close()
        }
    }

    private suspend fun reply(label: String, messages: List<ChatMessage>): String {
        val engine = shared!!
        val chunks = mutableListOf<String>()
        var firstMs = -1L
        val start = System.nanoTime()
        engine.generate(messages, maxTokens = 64).collect {
            if (firstMs < 0) firstMs = (System.nanoTime() - start) / 1_000_000
            chunks += it
        }
        val totalMs = (System.nanoTime() - start) / 1_000_000
        val decodeMs = (totalMs - firstMs).coerceAtLeast(1)
        val text = chunks.joinToString("")
        Log.i(TAG, "$label: first=${firstMs}ms total=${totalMs}ms chunks=${chunks.size} " +
            "decode~=${"%.1f".format((chunks.size - 1) * 1000.0 / decodeMs)}/s")
        Log.i(TAG, "$label reply: ${text.replace('\n', ' ')}")
        return text
    }

    private inline fun timed(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    companion object {
        private const val TAG = "LiteRtProbe"
        private var shared: LiteRtEngine? = null

        @JvmStatic
        @AfterClass
        fun release() {
            shared?.close()
            shared = null
        }
    }
}
