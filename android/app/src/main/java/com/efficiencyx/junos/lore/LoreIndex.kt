package com.efficiencyx.junos.lore

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.math.ln

@Serializable
private data class LoreLine(val messages: List<LoreMessage>)

@Serializable
private data class LoreMessage(val role: String, val content: String)

data class LoreHit(val text: String, val score: Double)

class LoreIndex(private val context: Context) {
    private val mutex = Mutex()
    private var index: Index? = null
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun search(query: String, limit: Int = 5): List<LoreHit> = withContext(Dispatchers.Default) {
        val loaded = mutex.withLock { index ?: build().also { index = it } }
        val queryTokens = tokens(query)
        if (queryTokens.isEmpty()) return@withContext emptyList()
        loaded.documents.mapNotNull { document ->
            val overlap = queryTokens.sumOf { token ->
                val count = document.terms[token] ?: 0
                if (count == 0) 0.0 else (loaded.idf[token] ?: 0.0) * (if (token in loaded.properNouns) 2.0 else 1.0)
            }
            overlap.takeIf { it >= 3.0 }?.let { LoreHit(document.answer, it) }
        }.sortedByDescending { it.score }.distinctBy { it.text }.take(limit.coerceIn(1, 6))
    }

    private fun build(): Index {
        val docs = context.assets.open("data/lore_dataset.jsonl").bufferedReader().useLines { lines ->
            lines.mapNotNull { line ->
                runCatching { json.decodeFromString<LoreLine>(line) }.getOrNull()?.let { row ->
                    val question = row.messages.firstOrNull { it.role == "user" }?.content ?: return@let null
                    val answer = row.messages.firstOrNull { it.role == "assistant" }?.content ?: return@let null
                    val source = "$question $answer"
                    Document(answer, tokens(source).groupingBy { it }.eachCount(), properTokens(source))
                }
            }.toList()
        }
        val frequency = mutableMapOf<String, Int>()
        docs.forEach { document -> document.terms.keys.forEach { frequency[it] = (frequency[it] ?: 0) + 1 } }
        val idf = frequency.mapValues { (_, count) -> ln((docs.size + 1.0) / (count + 1.0)) + 1.0 }
        return Index(docs, idf, docs.flatMapTo(mutableSetOf()) { it.proper })
    }

    private fun tokens(value: String): Set<String> = TOKEN.findAll(value.lowercase()).map { match ->
        match.value.let { if (it.length > 3 && it.endsWith('s')) it.dropLast(1) else it }
    }.filter { it.length >= 2 && it !in STOPWORDS }.toSet()

    private fun properTokens(value: String): Set<String> = PROPER.findAll(value).map { it.value.lowercase() }.toSet()

    private data class Document(val answer: String, val terms: Map<String, Int>, val proper: Set<String>)
    private data class Index(val documents: List<Document>, val idf: Map<String, Double>, val properNouns: Set<String>)

    companion object {
        private val TOKEN = Regex("[\\p{L}\\p{N}']+")
        private val PROPER = Regex("(?<![.!?]\\s)\\b[A-Z][a-z]{2,}\\b")
        private val STOPWORDS = setOf(
            "the", "and", "that", "this", "with", "from", "have", "what", "when", "where", "who", "why", "how",
            "morning", "coffee", "love", "hello", "please", "tell", "about", "does", "did", "are", "was", "were",
        )
    }
}
