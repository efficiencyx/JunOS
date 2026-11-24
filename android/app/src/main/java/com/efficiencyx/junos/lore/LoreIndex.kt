package com.efficiencyx.junos.lore

import com.efficiencyx.junos.retrieval.Hit
import com.efficiencyx.junos.retrieval.Index
import com.efficiencyx.junos.retrieval.Query
import com.efficiencyx.junos.retrieval.Retrieval
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.InputStream
import java.util.Locale

@Serializable
private data class LoreRow(val q: String = "", val a: String = "")

data class LoreHit(val text: String, val question: String, val score: Double, val cover: Double)

class LoreLookup(val facts: List<String>, val readAs: Map<String, String>, val didYouMean: List<String>)

// webapp/api/lib/lore.php. the corpus is webapp/lore_corpus.jsonl,
// copied into the apk by gradle. no corpus = no lore, NOT a crash
class LoreIndex(private val retrieval: Retrieval, private val open: () -> InputStream?) {
    private val mutex = Mutex()
    private var built: Built? = null
    private val json = Json { ignoreUnknownKeys = true }

    private val filler: Set<String> by lazy {
        retrieval.words.loreFiller.flatMapTo(mutableSetOf()) { listOf(it, retrieval.stem(it)) }
    }

    private class Built(
        val index: Index,
        val rows: List<LoreRow>,
        val proper: Set<String>,
        val strict: Set<String>,
        val fuzzy: List<String>,
    )

    suspend fun search(query: String, limit: Int = 5): List<LoreHit> = withContext(Dispatchers.Default) {
        load()?.let { search(it, query, limit.coerceIn(1, 6), true, mutableMapOf()) }.orEmpty()
    }

    // the canon facts this message earns, none = no block
    suspend fun gate(text: String): List<LoreHit> = withContext(Dispatchers.Default) {
        val idx = load() ?: return@withContext emptyList()
        if (text.isBlank()) return@withContext emptyList()
        if (namesIn(idx, text).isEmpty()) {
            val core = query(idx, text, mutableMapOf(), false)
            val said = core.terms.filterValues { it >= 1.0 }.keys
            val top = retrieval.score(idx.index, core, boost(idx, core)).firstOrNull()
            if (top == null || top.cover < GATE_COVER || top.matched.distinct().count { it in said } < GATE_WORDS) return@withContext emptyList()
        }
        val hits = search(idx, text, MAX_INJECT, true, mutableMapOf())
        if (hits.isEmpty()) return@withContext emptyList()
        val floor = hits[0].score * HIT_SHARE
        hits.filter { it.score >= floor }
    }

    // search_lore: the facts, what a typo was read as, or names to try
    suspend fun lookup(text: String, limit: Int): LoreLookup = withContext(Dispatchers.Default) {
        val idx = load() ?: return@withContext LoreLookup(emptyList(), emptyMap(), emptyList())
        val matched = mutableMapOf<String, String>()
        val facts = search(idx, text, limit.coerceIn(1, 6), true, matched).map { it.text }
        if (facts.isEmpty()) return@withContext LoreLookup(emptyList(), emptyMap(), didYouMean(idx, text))
        val readAs = retrieval.tokens(text).mapNotNull { token ->
            matched[token.stem]?.let { spelling(idx, it) }?.let { token.orig to it }
        }.toMap()
        LoreLookup(facts, readAs, emptyList())
    }

    private suspend fun load(): Built? = mutex.withLock { built ?: build()?.also { built = it } }

    private fun build(): Built? {
        val stream = runCatching { open() }.getOrNull() ?: return null
        val rows = stream.bufferedReader().useLines { lines ->
            lines.mapNotNull { line -> runCatching { json.decodeFromString<LoreRow>(line) }.getOrNull() }.filter { it.a.isNotEmpty() }.toList()
        }
        if (rows.isEmpty()) return null
        val cap = LinkedHashMap<String, Int>()
        val low = HashMap<String, Int>()
        for (row in rows) {
            for (text in listOf(row.q, row.a)) {
                for (token in retrieval.tokens(text)) {
                    // capitals ONLY mid-sentence count, see lore.php
                    var j = token.offset - 1
                    while (j >= 0 && text[j] == ' ') j--
                    val initial = j < 0 || text[j] in ".!?:\""
                    val upper = token.orig != token.orig.lowercase(Locale.ROOT) &&
                        token.orig.substring(0, token.orig.offsetByCodePoints(0, 1)).let { it == it.uppercase(Locale.ROOT) }
                    if (upper && !initial) cap[token.stem] = (cap[token.stem] ?: 0) + 1
                    else if (!upper) low[token.stem] = (low[token.stem] ?: 0) + 1
                }
            }
        }
        val index = retrieval.index(rows.map { mapOf("q" to it.q, "a" to it.a) }, linkedMapOf("q" to 1.5, "a" to 1.0))
        val days = retrieval.words.loreNotNames.map(retrieval::stem).toSet()
        val proper = LinkedHashSet<String>()
        val strict = HashSet<String>()
        for ((stem, c) in cap) {
            if (c >= 2 && c >= (low[stem] ?: 0)) proper += stem
            if (c >= 2 && stem !in low && stem !in days) strict += stem
        }
        val fuzzy = proper.filter { (index.idf[it] ?: 0.0) >= FUZZY_MIN_IDF }
        return Built(index, rows, proper, strict, fuzzy)
    }

    private fun query(idx: Built, text: String, matched: MutableMap<String, String>, withFiller: Boolean): Query {
        val q = retrieval.query(listOf(text to 1.0), true, filler, retrieval.words.loreAliases)
        if (withFiller) {
            val all = retrieval.query(listOf(text to FILLER_WEIGHT), false)
            for ((t, w) in all.terms) q.terms.putIfAbsent(t, w)
            for ((p, w) in all.pairs) q.pairs.putIfAbsent(p, w)
        }
        val resolved = LinkedHashMap<String, Double>()
        for ((t, w) in q.terms) {
            if (t in idx.index.idf) { resolved[t] = maxOf(resolved[t] ?: 0.0, w); continue }
            if (w < 1.0) continue
            val hit = retrieval.fuzzy(t, idx.fuzzy) ?: continue
            resolved[hit] = maxOf(resolved[hit] ?: 0.0, w * FUZZY_PENALTY)
            matched[t] = hit
        }
        return Query(resolved, q.pairs)
    }

    private fun boost(idx: Built, q: Query): Map<String, Double> =
        q.terms.keys.filter { it in idx.proper }.associateWith { PROPER_BOOST }

    private fun search(idx: Built, text: String, topK: Int, dedup: Boolean, matched: MutableMap<String, String>): List<LoreHit> {
        val q = query(idx, text, matched, true)
        if (q.terms.isEmpty()) return emptyList()
        val scored: List<Hit> = retrieval.score(idx.index, q, boost(idx, q))
        // "who is Shanice" lands on the row that asks exactly that
        for (hit in scored.take(40)) {
            val asked = retrieval.terms(idx.rows[hit.doc].q).distinct()
            val said = asked.count { it in q.terms }
            hit.score *= 1 + ASKED_BONUS * (if (asked.isNotEmpty()) said.toDouble() / asked.size else 0.0)
        }
        val ranked = scored.sortedByDescending { it.score }
        val out = mutableListOf<LoreHit>()
        val kept = mutableListOf<List<String>>()
        for (hit in ranked) {
            val row = idx.rows[hit.doc]
            if (dedup) {
                val terms = retrieval.terms(row.a)
                if (kept.any { retrieval.jaccard(terms, it) >= DEDUP_JACCARD }) continue
                kept += terms
            }
            out += LoreHit(row.a, row.q, round(hit.score, 4), round(hit.cover, 3))
            if (out.size >= topK) break
        }
        return out
    }

    private fun namesIn(idx: Built, text: String): List<String> {
        val names = LinkedHashSet<String>()
        val longFuzzy = idx.fuzzy.filter { it.length >= 4 }
        for (token in retrieval.tokens(text, filler)) {
            val before = text.substring(0, token.offset).trimEnd()
            val initial = before.isEmpty() || before.last() in ".!?:\"("
            val first = token.orig.substring(0, token.orig.offsetByCodePoints(0, 1))
            val capital = !initial && first != first.lowercase(Locale.ROOT)
            if (!capital && token.stem !in idx.strict) continue
            val stem = if (token.stem in idx.proper) token.stem else if (capital) retrieval.fuzzy(token.stem, longFuzzy) else null
            if (stem != null && (idx.index.idf[stem] ?: 0.0) >= FUZZY_MIN_IDF) names += stem
        }
        return names.toList()
    }

    private fun spelling(idx: Built, stem: String): String? {
        val pattern = Regex("\\b(" + Regex.escape(stem) + "[\\p{L}']*)", RegexOption.IGNORE_CASE)
        for (row in idx.rows) pattern.find(row.a)?.let { return it.groupValues[1] }
        return null
    }

    private fun didYouMean(idx: Built, text: String, max: Int = 3): List<String> {
        val near = LinkedHashMap<String, Int>()
        for (token in retrieval.tokens(text, filler)) {
            if (token.stem.length < 4) continue
            for (v in idx.fuzzy) {
                val d = Retrieval.levenshtein(token.stem, v)
                if (d <= maxOf(2, token.stem.length / 3)) near[v] = minOf(near[v] ?: 99, d)
            }
        }
        val out = LinkedHashSet<String>()
        for (stem in near.entries.sortedBy { it.value }.map { it.key }) {
            spelling(idx, stem)?.let(out::add)
            if (out.size >= max) break
        }
        return out.toList()
    }

    companion object {
        const val PROPER_BOOST = 2.0
        const val FUZZY_PENALTY = 0.6
        const val FUZZY_MIN_IDF = 2.0
        const val MAX_INJECT = 5
        const val DEDUP_JACCARD = 0.5
        const val GATE_COVER = 0.5
        const val GATE_WORDS = 2
        const val HIT_SHARE = 0.5
        const val ASKED_BONUS = 0.5
        const val FILLER_WEIGHT = 0.3

        // php round() is half away from zero, the same thing for scores that are never negative
        private fun round(value: Double, places: Int): Double {
            val scale = Math.pow(10.0, places.toDouble())
            return Math.round(value * scale) / scale
        }
    }
}
