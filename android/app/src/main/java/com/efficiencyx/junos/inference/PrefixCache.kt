package com.efficiencyx.junos.inference

import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.InputData
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.Session
import com.google.ai.edge.litertlm.SessionConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.google.ai.edge.litertlm.tool
import java.io.Closeable

// the live context NEVER goes into a base, it'd sit in her history forever.
// clone() is LiteRT-LM main only (a8b25358), no clone = no cache
internal class PrefixCache(private val engine: Engine) : Closeable {
    private data class Key(val system: String?, val tools: List<String>, val think: Boolean, val temperature: Float)
    private class Base(val key: Key, val session: Session, var text: String = "")

    // LRU. "auto" flips <|think|> at the very top, regenerate wants the pre-fork base
    private val bases = ArrayList<Base>()
    private val generationPrompts = HashMap<Boolean, String>()

    class Turn(val session: Session, val prompt: String)

    @Synchronized
    fun open(system: String?, messages: List<ChatMessage>, tools: List<String>, think: Boolean, temperature: Float): Turn? {
        val cut = messages.indexOfLast { it.role == "user" }
        if (cut < 0) return null
        val key = Key(system, tools, think, temperature)
        val history = render(key, messages.subList(0, cut))
        val full = render(key, messages)
        if (!full.startsWith(history)) return null

        val base = extend(key, history, fork = false)
        val clone = CLONE!!.invoke(base.session) as Session
        return Turn(clone, full.substring(history.length) + generationPrompt(think))
    }

    // GPU switching back to a base that isn't live is ~4 s on the g86, extending the live one is free
    @Synchronized
    fun warm(system: String?, messages: List<ChatMessage>, tools: List<String>, think: Boolean, temperature: Float) {
        val key = Key(system, tools, think, temperature)
        if (bases.none { it.key == key }) return
        extend(key, render(key, messages), fork = true)
    }

    private fun extend(key: Key, text: String, fork: Boolean): Base {
        val best = bases.filter { it.key == key && text.startsWith(it.text) }.maxByOrNull { it.text.length }
        val base = when {
            best == null -> Base(key, engine.createSession(SessionConfig(SamplerConfig(64, 0.95, key.temperature.toDouble(), 0))))
            fork && best.text != text -> Base(key, CLONE!!.invoke(best.session) as Session, best.text)
            else -> best
        }
        if (base !== best) bases += base
        try {
            if (text.length > base.text.length) {
                prefillPieces(text.substring(base.text.length)).forEach { base.session.runPrefill(listOf(InputData.Text(it))) }
                base.text = text
            }
        } catch (error: Throwable) {
            bases.remove(base)
            base.session.close()
            throw error
        }
        bases.remove(base)
        bases += base
        while (bases.size > MAX_BASES) bases.removeAt(0).session.close()
        return base
    }

    @OptIn(ExperimentalApi::class)
    private fun render(key: Key, messages: List<ChatMessage>): String =
        engine.createConversation(config(key.system, key.tools, key.think, messages)).use { it.renderPrefaceIntoString() }

    @OptIn(ExperimentalApi::class)
    private fun generationPrompt(think: Boolean): String = generationPrompts.getOrPut(think) {
        val probe = ChatMessage("user", "x")
        val withTurn = render(Key(null, emptyList(), think, 0f), listOf(probe))
        val asked = engine.createConversation(config(null, emptyList(), think, emptyList()))
            .use { it.renderMessageIntoString(Message.user(probe.content)) }
        check(asked.startsWith(withTurn)) { "template renders a user turn two different ways" }
        asked.substring(withTurn.length)
    }

    private fun config(system: String?, tools: List<String>, think: Boolean, messages: List<ChatMessage>) = ConversationConfig(
        systemInstruction = system?.let { Contents.of(it) },
        initialMessages = messages.map { it.toLiteRtMessage() },
        tools = tools.map { tool(DeclaredTool(it)) },
        thinkingConfig = ThinkingConfig(think),
    )

    @Synchronized
    override fun close() {
        bases.forEach { runCatching { it.session.close() } }
        bases.clear()
    }

    companion object {
        private const val MAX_BASES = 3
        private val CLONE = runCatching { Session::class.java.getMethod("clone") }.getOrNull()
        val supported: Boolean get() = CLONE != null
    }
}
