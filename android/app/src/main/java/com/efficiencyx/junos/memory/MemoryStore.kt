package com.efficiencyx.junos.memory

import android.content.Context
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.security.SecureRandom

@Serializable
data class MemoryNote(
    val id: String,
    val category: String,
    val text: String,
    val links: List<String>,
    val created: Long,
    val updated: Long,
)

@Serializable
data class JournalEntry(val date: String, val text: String)

@Serializable
data class MemorySnapshot(
    val categories: List<MemoryCategory>,
    val notes: List<MemoryNote>,
    val journal: JournalPayload,
)

@Serializable
data class MemoryCategory(val slug: String, val count: Int, val updated: Long)

@Serializable
data class JournalPayload(val entries: List<JournalEntry>)

@Serializable
private data class MetaEntry(val created: Long, val updated: Long)

class MemoryStore(context: Context) {
    private val root = File(context.filesDir, "memory/user-1").also { it.mkdirs() }
    private val mutex = Mutex()
    private val random = SecureRandom()
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    suspend fun snapshot(): MemorySnapshot = withContext(Dispatchers.IO) {
        mutex.withLock { snapshotUnlocked() }
    }

    suspend fun add(category: String, memory: String): MemoryNote = withContext(Dispatchers.IO) {
        mutex.withLock {
            val text = normalize(memory)
            require(text.isNotBlank() && text.length <= 500) { "invalid_memory" }
            val slug = normalizeCategory(category)
            val current = snapshotUnlocked().notes
            current.firstOrNull { it.category == slug && it.text.equals(text, true) }?.let { return@withLock it }
            val ids = current.mapTo(mutableSetOf()) { it.id }
            val id = generateId(ids)
            val now = System.currentTimeMillis() / 1000
            val note = MemoryNote(id, slug, text, links(text), now, now)
            writeCategory(slug, current.filter { it.category == slug } + note)
            val meta = loadMeta().toMutableMap()
            meta[id] = MetaEntry(now, now)
            writeMeta(meta)
            note
        }
    }

    suspend fun delete(id: String): Boolean = withContext(Dispatchers.IO) {
        mutex.withLock {
            require(id.matches(Regex("[a-z0-9]{5}")))
            val snapshot = snapshotUnlocked()
            val note = snapshot.notes.firstOrNull { it.id == id } ?: return@withLock false
            writeCategory(note.category, snapshot.notes.filter { it.category == note.category && it.id != id })
            val meta = loadMeta().toMutableMap().also { it.remove(id) }
            writeMeta(meta)
            true
        }
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        mutex.withLock {
            root.listFiles()?.forEach { file -> if (file.isFile) file.delete() }
        }
    }

    suspend fun recentContext(maxChars: Int = 2500): String {
        val snapshot = snapshot()
        if (snapshot.notes.isEmpty()) return ""
        val grouped = snapshot.notes.groupBy { it.category }
            .entries.sortedByDescending { (_, notes) -> notes.maxOfOrNull { it.updated } ?: 0 }
        val blocks = grouped.map { (category, notes) ->
            "### ${category.replaceFirstChar { it.uppercase() }}\n" +
                notes.sortedByDescending { it.updated }.joinToString("\n") { note ->
                    val created = MemoryDates.day(note.created)
                    "- " + MemoryDates.stamp(note.text, created) +
                        MemoryDates.render(note.text, created).replace(WIKI_LINK, "$1")
                }
        }
        val out = StringBuilder(CONTEXT_HEADER)
        for (block in blocks) {
            if (out.length + block.length + 2 > maxChars) continue
            out.append('\n').append(block).append('\n')
        }
        return out.toString().trim()
    }

    private fun snapshotUnlocked(): MemorySnapshot {
        val meta = loadMeta()
        val notes = root.listFiles { file -> file.extension == "md" && file.name != "journal.md" }
            .orEmpty().flatMap { file -> parseCategory(file, meta) }
        val categories = notes.groupBy { it.category }.map { (slug, values) ->
            MemoryCategory(slug, values.size, values.maxOfOrNull { it.updated } ?: 0)
        }.sortedBy { it.slug }
        return MemorySnapshot(categories, notes.sortedByDescending { it.updated }, JournalPayload(parseJournal()))
    }

    private fun parseCategory(file: File, meta: Map<String, MetaEntry>): List<MemoryNote> {
        val slug = file.nameWithoutExtension
        return file.readLines().mapNotNull { line ->
            val match = NOTE_LINE.matchEntire(line.trim()) ?: return@mapNotNull null
            val id = match.groupValues[2]
            val stamp = meta[id] ?: MetaEntry(0, 0)
            MemoryNote(id, slug, match.groupValues[1].trim(), links(match.groupValues[1]), stamp.created, stamp.updated)
        }
    }

    private fun writeCategory(category: String, notes: List<MemoryNote>) {
        val title = category.replaceFirstChar { it.uppercase() }
        val body = buildString {
            append("# ").append(title).append("\n\n")
            for (note in notes) append("- ").append(note.text).append(" ^").append(note.id).append('\n')
        }
        atomicWrite(File(root, "$category.md"), body)
    }

    private fun loadMeta(): Map<String, MetaEntry> {
        val file = File(root, "meta.json")
        if (!file.isFile) return emptyMap()
        return runCatching { json.decodeFromString<Map<String, MetaEntry>>(file.readText()) }.getOrDefault(emptyMap())
    }

    private fun writeMeta(value: Map<String, MetaEntry>) = atomicWrite(File(root, "meta.json"), json.encodeToString(value))

    private fun parseJournal(): List<JournalEntry> {
        val file = File(root, "journal.md")
        if (!file.isFile) return emptyList()
        val entries = mutableListOf<JournalEntry>()
        var date: String? = null
        val body = mutableListOf<String>()
        fun flush() {
            val key = date ?: return
            entries += JournalEntry(key, body.joinToString("\n").trim())
            body.clear()
        }
        for (line in file.readLines()) {
            val heading = JOURNAL_HEADING.matchEntire(line.trim())
            if (heading != null) {
                flush()
                date = heading.groupValues[1]
            } else if (date != null) body += line
        }
        flush()
        return entries.sortedByDescending { it.date }
    }

    private fun atomicWrite(file: File, content: String) {
        file.parentFile?.mkdirs()
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try {
            output.write(content.toByteArray(Charsets.UTF_8))
            output.flush()
            atomic.finishWrite(output)
        } catch (error: Throwable) {
            atomic.failWrite(output)
            throw error
        }
    }

    private fun generateId(used: Set<String>): String {
        repeat(100) {
            val id = buildString(5) { repeat(5) { append(ALPHABET[random.nextInt(ALPHABET.length)]) } }
            if (id !in used) return id
        }
        error("memory_id_exhausted")
    }

    private fun normalize(value: String) = value.replace(Regex("[\\x00-\\x1f\\x7f]+"), " ")
        .replace(Regex("\\s+"), " ").trim().removePrefix("- ")

    private fun normalizeCategory(value: String): String {
        val slug = value.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
        return slug.takeIf { it in CATEGORIES } ?: "events"
    }

    private fun links(text: String) = WIKI_LINK.findAll(text).map { it.groupValues[1] }.distinct().toList()

    companion object {
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
        private val CATEGORIES = setOf("preferences", "work", "health", "family", "plans", "boundaries", "events")
        private val NOTE_LINE = Regex("^-\\s+(.+?)\\s+\\^([a-z0-9]{5})$")
        private val WIKI_LINK = Regex("\\[\\[([^]\\n]+)]]")
        private val JOURNAL_HEADING = Regex("^##\\s+(\\d{4}-\\d{2}-\\d{2})$")

        // Word for word what memory_recent_context() in webapp/api/chat.php puts
        // in front of the notes, she reads the same block on both sides.
        private const val CONTEXT_HEADER = "## Durable memory notes\n" +
            "Words like \"tomorrow\" or \"next friday\" in a note mean the day you wrote it, not now. " +
            "Where a note already spells the real day out in brackets, use that day and trust it - " +
            "do not work the date out again yourself."
    }
}
