package com.efficiencyx.junos.retrieval

import java.util.Locale

// webapp/api/lib/chat/recall.php and recall_word_at() / recall_excerpt() in lib/text.php
class Recall(private val retrieval: Retrieval) {
    class Doc(val text: String, val ref: Any)

    // half his words, a synonym counts half. ALL of them meant one stray word found nothing
    fun enough(docTerms: List<String>, query: Query): Boolean {
        val said = query.terms.filterValues { it >= 1.0 }.keys
        if (said.isEmpty()) return false
        val have = docTerms.toSet()
        var got = 0.0
        for ((t, w) in query.terms) if (t in have) got += if (w >= 1.0) 1.0 else 0.5
        return got >= maxOf(1.0, Math.ceil(said.size / 2.0))
    }

    // the whole phrase beats any word soup, then score, then newest (docs come newest first)
    fun rank(docs: List<Doc>, phrase: String, query: Query, limit: Int): List<Pair<Doc, Int>> {
        if (docs.isEmpty()) return emptyList()
        val scores = retrieval.score(retrieval.index(docs.map { mapOf("t" to it.text) }, linkedMapOf("t" to 1.0)), query)
            .associateBy { it.doc }
        data class Ranked(val i: Int, val whole: Boolean, val score: Double)
        val ranked = docs.indices.mapNotNull { i ->
            val whole = wordAt(docs[i].text, phrase) != null
            val hit = scores[i]
            if (!whole && (hit == null || !enough(hit.matched, query))) null else Ranked(i, whole, hit?.score ?: 0.0)
        }.sortedWith(compareByDescending<Ranked> { it.whole }.thenByDescending { it.score }.thenBy { it.i })
        return ranked.take(limit).map { r ->
            val text = docs[r.i].text
            docs[r.i] to (if (r.whole) wordAt(text, phrase)!! else firstHit(text, query))
        }
    }

    private fun firstHit(text: String, query: Query): Int =
        retrieval.tokens(text).firstOrNull { (query.terms[it.stem] ?: 0.0) >= 1.0 }?.offset ?: 0

    // names from her notes one typo away from what she searched for
    fun tryNames(noteTexts: List<String>, text: String): List<String> {
        val names = LinkedHashMap<String, String>()
        for (note in noteTexts) {
            for (m in NAME.findAll(note)) {
                val before = note.substring(0, m.range.first).trimEnd()
                if (before.isEmpty() || before.last() in ".!?") continue
                if (m.value != "Anon") names[m.value.lowercase(Locale.ROOT)] = m.value
            }
        }
        val out = LinkedHashSet<String>()
        for (token in retrieval.tokens(text)) {
            val low = token.orig.lowercase(Locale.ROOT)
            if (low.length < 4 || low in names) continue
            for ((k, w) in names) if (Retrieval.levenshtein(low, k) <= (if (low.length <= 6) 1 else 2)) out += w
        }
        return out.take(3)
    }

    companion object {
        private val NAME = Regex("\\b\\p{Lu}[\\p{L}']{3,}")

        fun wordAt(text: String, needle: String): Int? {
            if (needle.isBlank()) return null
            return Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(needle), RegexOption.IGNORE_CASE).find(text)?.range?.first
        }

        fun excerpt(text: String, at: Int, max: Int = 500): String {
            if (text.length <= max) return text
            val keep = max - 2
            val start = maxOf(0, minOf(at - keep / 3, text.length - keep))
            return (if (start > 0) "…" else "") + text.substring(start, start + keep) + (if (start + keep < text.length) "…" else "")
        }
    }
}
