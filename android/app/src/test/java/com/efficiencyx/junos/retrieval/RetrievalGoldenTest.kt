package com.efficiencyx.junos.retrieval

import com.efficiencyx.junos.lore.LoreIndex
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// .github/scripts/retrieval-golden.json, the file retrieval.test.php checks
// the php side against. same tokens, same top lore row, same gate
class RetrievalGoldenTest {
    private val repo = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .first { File(it, ".github/scripts/retrieval-golden.json").isFile }
    private val retrieval = Retrieval(Words.parse(File(repo, "webapp/api/lib/retrieval.json").readText()))
    private val lore = LoreIndex(retrieval) { File(repo, "webapp/lore_corpus.jsonl").inputStream() }
    private val golden = Json.parseToJsonElement(File(repo, ".github/scripts/retrieval-golden.json").readText()).jsonObject

    @Test
    fun termsMatchPhp() {
        for (case in golden.getValue("tokens").jsonArray) {
            val c = case.jsonObject
            val want = c.getValue("terms").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(c.getValue("in").jsonPrimitive.content, want, retrieval.terms(c.getValue("in").jsonPrimitive.content))
        }
    }

    @Test
    fun loreTopMatchesPhp() = runTest {
        for (case in golden.getValue("lore_top").jsonArray) {
            val c = case.jsonObject
            val q = c.getValue("q").jsonPrimitive.content
            assertEquals(q, c.getValue("has").jsonPrimitive.content, lore.search(q, 1).firstOrNull()?.question)
        }
    }

    @Test
    fun gateMatchesPhp() = runTest {
        for (case in golden.getValue("gate").jsonArray) {
            val c = case.jsonObject
            val q = c.getValue("q").jsonPrimitive.content
            assertEquals(q, c.getValue("fires").jsonPrimitive.boolean, lore.gate(q).isNotEmpty())
        }
    }

    @Test
    fun typoReadAsAndDidYouMean() = runTest {
        assertEquals(mapOf("Annallie" to "Annalie"), lore.lookup("Annallie", 1).readAs)
        assertEquals(listOf("Ecclesiasticalot"), lore.lookup("Ecclesiasticl", 4).didYouMean)
    }

    @Test
    fun recallNeedsHalfTheWords() {
        val recall = Recall(retrieval)
        val q = retrieval.query(listOf("boss moved my schedule" to 1.0))
        val docs = listOf(Recall.Doc("my boss moved my shifts again", 1), Recall.Doc("the party was loud", 2))
        assertEquals(listOf(1), recall.rank(docs, "boss moved my schedule", q, 5).map { it.first.ref })
    }
}
