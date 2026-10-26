package com.efficiencyx.junos

import android.os.Debug
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.efficiencyx.junos.inference.ChatEngine
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
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.AfterClass
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch

// can a Conversation prefilled ahead of time (system + tools + history)
// take the next user turn without paying the prefill again? same model
// rules as LiteRtProbeTest, -e backend cpu for the cpu side.
@RunWith(AndroidJUnit4::class)
class LiteRtCacheProbeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun load() {
        val models = ModelStore(context)
        assumeTrue("no jun.litertlm in files/models", models.litertReady())
        if (shared != null) return
        val backend = if (InstrumentationRegistry.getArguments().getString("backend") == "cpu") Backend.CPU() else Backend.GPU()
        val engine = Engine(EngineConfig(models.litertModelFile.absolutePath, backend, null, null, 8192, null, models.litertCacheDir.absolutePath))
        Log.i(TAG, "load=${timed { engine.initialize() }}ms backend=$backend")
        shared = engine
    }

    @Test
    fun coldVsWarm() {
        val engine = shared!!
        val cold = timedCreate(engine, config(prefill = false))
        Log.i(TAG, "cold: create=${lastMs}ms tokens=${cold.getTokenCount()}")
        val coldFirst = firstTokenMs(cold)
        Log.i(TAG, "cold: first token=${coldFirst}ms tokens after=${cold.getTokenCount()}")
        cold.close()

        val before = pssMb()
        val warm = timedCreate(engine, config(prefill = true))
        // tokenCount here says whether initialMessages went into the
        // preface prefill or only the system part did
        Log.i(TAG, "warm: create=${lastMs}ms tokens=${warm.getTokenCount()} pss +${pssMb() - before}MB")
        val warmFirst = firstTokenMs(warm)
        Log.i(TAG, "warm: first token=${warmFirst}ms tokens after=${warm.getTokenCount()}")
        warm.close()
    }

    @Test
    fun twoConversationsAtOnce() {
        val engine = shared!!
        val warm = timedCreate(engine, config(prefill = true))
        val side = runCatching {
            engine.createConversation(ConversationConfig(maxOutputToken = 16)).use { firstTokenMs(it, "give me a title for this chat") }
        }
        Log.i(TAG, "second conversation: ${side.fold({ "ok first=${it}ms" }, { "FAILED ${it.message}" })}")
        val after = runCatching { firstTokenMs(warm) }
        Log.i(TAG, "warm after side call: ${after.fold({ "ok first=${it}ms tokens=${warm.getTokenCount()}" }, { "FAILED ${it.message}" })}")
        warm.close()
    }

    private fun config(prefill: Boolean) = ConversationConfig(
        systemInstruction = Contents.of(systemPrompt()),
        initialMessages = HISTORY.map { (role, text) -> if (role == "user") Message.user(text) else Message.model(text) },
        tools = ChatEngine.TOOL_SCHEMAS.map { tool(ProbeTool(it)) },
        samplerConfig = SamplerConfig(64, 0.95, 0.8, 0),
        automaticToolCalling = false,
        prefillPrefaceOnInit = prefill,
        maxOutputToken = 32,
    )

    private fun systemPrompt() = context.assets.open("system_prompt.txt").bufferedReader().use { it.readText() }
        .replace(Regex("(?m)^<!--/?tools-->\\R"), "")

    private fun timedCreate(engine: Engine, config: ConversationConfig): Conversation {
        val start = System.nanoTime()
        return engine.createConversation(config).also { lastMs = (System.nanoTime() - start) / 1_000_000 }
    }

    private fun firstTokenMs(conversation: Conversation, text: String = "so what are we doing tonight?"): Long {
        val start = System.nanoTime()
        var first = -1L
        var failure: Throwable? = null
        val done = CountDownLatch(1)
        conversation.sendMessageAsync(Message.user(text), object : MessageCallback {
            override fun onMessage(message: Message) {
                if (first < 0 && message.contents.contents.any { it is Content.Text }) first = (System.nanoTime() - start) / 1_000_000
            }
            override fun onDone() = done.countDown()
            override fun onError(error: Throwable) { failure = error; done.countDown() }
        })
        done.await()
        failure?.let { throw it }
        return first
    }

    private fun pssMb() = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }.totalPss / 1024

    private inline fun timed(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    private class ProbeTool(private val schema: String) : OpenApiTool {
        override fun getToolDescriptionJsonString(): String =
            Json.parseToJsonElement(schema).jsonObject["function"]?.toString() ?: schema
        override fun execute(paramsJsonString: String): String = "{}"
    }

    companion object {
        private const val TAG = "LiteRtCacheProbe"
        private var shared: Engine? = null
        private var lastMs = 0L

        private val HISTORY = List(6) { i ->
            listOf(
                "user" to "turn $i. tell me something about your week, the boring parts too.",
                "assistant" to "fine. monday was laundry, tuesday was more laundry, and on wednesday the vending machine ate my coins again. thrilling stuff, really.",
            )
        }.flatten()

        @JvmStatic
        @AfterClass
        fun release() {
            shared?.close()
            shared = null
        }
    }
}
