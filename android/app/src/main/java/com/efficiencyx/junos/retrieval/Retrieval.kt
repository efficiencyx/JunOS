package com.efficiencyx.junos.retrieval

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

// webapp/api/lib/retrieval.php, line for line. .github/scripts/
// retrieval-golden.json holds both to the same terms, hits and gate
data class Token(val stem: String, val orig: String, val offset: Int)

class Query(val terms: LinkedHashMap<String, Double>, val pairs: LinkedHashMap<String, Double>)

class Index(
    val n: Int,
    val post: LinkedHashMap<String, LinkedHashMap<Int, Double>>,
    val idf: Map<String, Double>,
    val pairs: Map<String, List<Int>>,
)

class Hit(val doc: Int, var score: Double, var cover: Double = 0.0, val matched: MutableList<String> = mutableListOf())

class Words(
    val stop: Set<String>,
    val synonyms: List<List<String>>,
    val loreFiller: List<String>,
    val loreNotNames: List<String>,
    val loreAliases: List<List<String>>,
) {
    companion object {
        fun parse(text: String): Words {
            val root = Json.parseToJsonElement(text).jsonObject
            fun groups(key: String) = root.getValue(key).jsonArray.map { group -> group.jsonArray.map { it.jsonPrimitive.content } }
            fun words(key: String) = root.getValue(key).jsonPrimitive.content.split(' ').filter { it.isNotEmpty() }
            val stop = (root.getValue("stop") as JsonObject).values.flatMap { it.jsonPrimitive.content.split(Regex("\\s+")) }
                .filter { it.isNotEmpty() }.toSet()
            return Words(stop, groups("synonyms"), words("lore_filler"), words("lore_not_names"), groups("lore_aliases"))
        }
    }
}

class Retrieval(val words: Words) {
    private val synonymGroups: List<List<List<String>>> by lazy { words.synonyms.map(::phraseGroup) }

    fun phraseGroup(group: List<String>): List<List<String>> = group.map { terms(it) }.filter { it.isNotEmpty() }

    // light english stemmer. ascii words only, everything else is left alone
    fun stem(word: String): String {
        if (!ASCII_WORD.matches(word)) return word
        var w = word
        val n = w.length
        if (n > 4 && w.endsWith("ies")) return w.dropLast(3) + "y"
        if (n > 4 && w.endsWith("sses")) return w.dropLast(2)
        if (n > 4 && ES_PLURAL.containsMatchIn(w)) return w.dropLast(2)
        when {
            n > 5 && w.endsWith("ing") -> w = w.dropLast(3)
            n > 4 && w.endsWith("ed") -> w = w.dropLast(2)
            n > 3 && w.endsWith("s") && !NOT_PLURAL.containsMatchIn(w) -> w = w.dropLast(1)
            else -> return if (w.length >= 4 && w.endsWith("e")) w.dropLast(1) else w
        }
        if (DOUBLED.containsMatchIn(w)) w = w.dropLast(1)
        return if (w.length >= 4 && w.endsWith("e")) w.dropLast(1) else w
    }

    fun tokens(s: String, extraStop: Set<String> = emptySet()): List<Token> {
        val out = mutableListOf<Token>()
        for (match in WORD.findAll(s)) {
            val w = match.value
            if (CJK_START.containsMatchIn(w)) {
                val chars = w.codePoints().toArray().map { String(Character.toChars(it)) }
                if (chars.size == 1) out += Token(w, w, match.range.first)
                var offset = match.range.first
                for (i in 0 until chars.size - 1) {
                    out += Token(chars[i] + chars[i + 1], chars[i] + chars[i + 1], offset)
                    offset += chars[i].length
                }
                continue
            }
            val lower = w.lowercase(Locale.ROOT)
            if (lower.codePointCount(0, lower.length) < 2 || lower in words.stop) continue
            val stemmed = stem(lower)
            if (lower in extraStop || stemmed in extraStop) continue
            out += Token(stemmed, w, match.range.first)
        }
        return out
    }

    fun terms(s: String, extraStop: Set<String> = emptySet()): List<String> = tokens(s, extraStop).map { it.stem }

    fun query(
        parts: List<Pair<String, Double>>,
        expand: Boolean = true,
        extraStop: Set<String> = emptySet(),
        extraGroups: List<List<String>> = emptyList(),
    ): Query {
        val terms = LinkedHashMap<String, Double>()
        val pairs = LinkedHashMap<String, Double>()
        for ((text, weight) in parts) {
            val seq = terms(text, extraStop)
            seq.forEachIndexed { i, t ->
                terms[t] = max(terms[t] ?: 0.0, weight)
                if (i > 0) {
                    val pair = seq[i - 1] + " " + t
                    pairs[pair] = max(pairs[pair] ?: 0.0, weight)
                }
            }
        }
        if (expand && terms.isNotEmpty()) {
            val have = LinkedHashMap(terms)
            for (group in synonymGroups + extraGroups.map(::phraseGroup)) {
                var hit = 0.0
                for (phrase in group) hit = max(hit, phrase.minOf { have[it] ?: 0.0 })
                if (hit <= 0) continue
                for (phrase in group) for (t in phrase) terms[t] = max(terms[t] ?: 0.0, hit * EXPAND_WEIGHT)
            }
        }
        return Query(terms, pairs)
    }

    fun index(docs: List<Map<String, String>>, fieldWeights: LinkedHashMap<String, Double>): Index {
        val len = mutableListOf<Map<String, Int>>()
        val tfs = mutableListOf<Map<String, LinkedHashMap<String, Int>>>()
        val docPairs = mutableListOf<LinkedHashSet<String>>()
        val sum = LinkedHashMap<String, Int>().apply { fieldWeights.keys.forEach { put(it, 0) } }
        for (doc in docs) {
            val lens = mutableMapOf<String, Int>()
            val fields = mutableMapOf<String, LinkedHashMap<String, Int>>()
            val pairSet = LinkedHashSet<String>()
            for (field in fieldWeights.keys) {
                val seq = terms(doc[field].orEmpty())
                lens[field] = seq.size
                sum[field] = sum.getValue(field) + seq.size
                val tf = LinkedHashMap<String, Int>()
                seq.forEachIndexed { j, t ->
                    tf[t] = (tf[t] ?: 0) + 1
                    if (j > 0) pairSet += seq[j - 1] + " " + t
                }
                fields[field] = tf
            }
            len += lens
            tfs += fields
            docPairs += pairSet
        }
        val n = docs.size
        val avg = sum.mapValues { (_, s) -> max(1.0, s.toDouble() / max(1, n)) }
        val post = LinkedHashMap<String, LinkedHashMap<Int, Double>>()
        val pairs = LinkedHashMap<String, MutableList<Int>>()
        tfs.forEachIndexed { i, fields ->
            val acc = LinkedHashMap<String, Double>()
            for ((field, w) in fieldWeights) {
                val norm = 1 - B + B * (len[i].getValue(field) / avg.getValue(field))
                for ((t, c) in fields[field].orEmpty()) acc[t] = (acc[t] ?: 0.0) + w * c / norm
            }
            for ((t, v) in acc) post.getOrPut(t) { LinkedHashMap() }[i] = v
            for (p in docPairs[i]) pairs.getOrPut(p) { mutableListOf() } += i
        }
        val idf = post.mapValues { (_, docsOf) -> ln(1 + (n - docsOf.size + 0.5) / (docsOf.size + 0.5)) }
        return Index(n, post, idf, pairs)
    }

    // best first, stable on ties like php's uasort
    fun score(index: Index, query: Query, boost: Map<String, Double> = emptyMap()): List<Hit> {
        var top = 0.0
        val scores = LinkedHashMap<Int, Hit>()
        for ((t, qw) in query.terms) {
            val idf = index.idf[t] ?: continue
            val w = qw * idf * (boost[t] ?: 1.0)
            if (qw >= 1.0) top += w
            for ((i, tf) in index.post.getValue(t)) {
                val hit = scores.getOrPut(i) { Hit(i, 0.0) }
                hit.score += w * tf * (K1 + 1) / (K1 + tf)
                hit.matched += t
            }
        }
        if (scores.isEmpty()) return emptyList()
        for ((p, qw) in query.pairs) {
            for (i in index.pairs[p].orEmpty()) {
                val hit = scores[i] ?: continue
                val (a, b) = p.split(' ', limit = 2)
                hit.score += PAIR_BONUS * qw * (((index.idf[a] ?: 0.0) + (index.idf[b] ?: 0.0)) / 2)
            }
        }
        val bar = top * (K1 + 1)
        for (hit in scores.values) hit.cover = if (bar > 0) min(1.0, hit.score / bar) else 0.0
        return scores.values.sortedByDescending { it.score }
    }

    fun fuzzy(tok: String, vocab: List<String>): String? {
        val n = tok.length
        if (n < 4) return null
        val maxD = if (n <= 7) 1 else 2
        var best: String? = null
        var bestD = maxD + 1
        for (v in vocab) {
            if (kotlin.math.abs(v.length - n) > maxD) continue
            val d = levenshtein(tok, v)
            if (d <= maxD && d < bestD) { best = v; bestD = d }
        }
        return best
    }

    fun jaccard(a: List<String>, b: List<String>): Double {
        val sa = a.toSet()
        val sb = b.toSet()
        val inter = sa.count { it in sb }
        val union = sa.size + sb.size - inter
        return if (union > 0) inter.toDouble() / union else 0.0
    }

    companion object {
        const val K1 = 1.2
        const val B = 0.75
        const val EXPAND_WEIGHT = 0.5
        const val PAIR_BONUS = 0.5
        private const val CJK = "\\x{0E00}-\\x{0E7F}\\x{1100}-\\x{11FF}\\x{2E80}-\\x{2FDF}\\x{3005}-\\x{3007}\\x{3021}-\\x{3029}\\x{3038}-\\x{303B}\\x{3041}-\\x{309F}\\x{30A0}-\\x{30FF}\\x{3130}-\\x{318F}\\x{31F0}-\\x{31FF}\\x{3400}-\\x{4DBF}\\x{4E00}-\\x{9FFF}\\x{AC00}-\\x{D7AF}\\x{F900}-\\x{FAFF}\\x{FF66}-\\x{FF9F}\\x{20000}-\\x{2FA1F}"
        private val WORD = Regex("(?:(?![\\p{P}\\p{S}])[$CJK])+|(?:(?![$CJK])[\\p{L}\\p{N}\\p{M}])+")
        private val CJK_START = Regex("^[$CJK]")
        private val ASCII_WORD = Regex("^[a-z]+$")
        private val ES_PLURAL = Regex("(?:s|x|z|ch|sh)es$")
        private val NOT_PLURAL = Regex("(?:ss|us|is)$")
        private val DOUBLED = Regex("([bdfgklmnprtz])\\1$")

        // php's levenshtein() counts bytes, this counts chars. same on the
        // ascii names the lore fuzzy-matches, an accented word can differ
        fun levenshtein(a: String, b: String): Int {
            var prev = IntArray(b.length + 1) { it }
            for (i in 1..a.length) {
                val cur = IntArray(b.length + 1)
                cur[0] = i
                for (j in 1..b.length) {
                    cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
                }
                prev = cur
            }
            return prev[b.length]
        }
    }
}
