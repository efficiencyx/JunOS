package com.efficiencyx.junos.memory

import android.content.Context
import com.efficiencyx.junos.retrieval.Retrieval
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
import java.time.LocalDate

@Serializable
data class MemoryNote(
    val id: String,
    val category: String,
    val text: String,
    val links: List<String>,
    val created: Long,
    val updated: Long,
    val source: NoteSource? = null,
    val revisions: List<NoteSource> = emptyList(),
    val dated: Long = 0,
) {
    val anchor: Long get() = if (dated > 0) dated else created
}

// lib/memory.php's meta source. no memory pass here, so revisions stay empty
@Serializable
data class NoteSource(val kind: String, val conv: Long? = null, val msg: Long? = null)

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
private data class MetaEntry(val created: Long, val updated: Long, val source: NoteSource? = null, val dated: Long = 0)

class MemoryStore(context: Context, private val retrieval: Retrieval) {
    private val root = File(context.filesDir, "memory/user-1").also { it.mkdirs() }
    private val mutex = Mutex()
    private val random = SecureRandom()
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    suspend fun snapshot(): MemorySnapshot = withContext(Dispatchers.IO) {
        mutex.withLock { snapshotUnlocked() }
    }

    suspend fun add(category: String, memory: String, source: NoteSource? = null): MemoryNote = withContext(Dispatchers.IO) {
        mutex.withLock {
            val text = normalize(memory)
            require(text.isNotBlank() && text.length <= 500) { "invalid_memory" }
            val slug = normalizeCategory(category)
            val current = snapshotUnlocked().notes
            current.firstOrNull { it.category == slug && it.text.equals(text, true) }?.let { return@withLock it }
            val ids = current.mapTo(mutableSetOf()) { it.id }
            val id = generateId(ids)
            val now = System.currentTimeMillis() / 1000
            val note = MemoryNote(id, slug, text, links(text), now, now, source)
            writeCategory(slug, current.filter { it.category == slug } + note)
            val meta = loadMeta().toMutableMap()
            meta[id] = MetaEntry(now, now, source)
            writeMeta(meta)
            note
        }
    }

    suspend fun edit(id: String, memory: String): Boolean = withContext(Dispatchers.IO) {
        mutex.withLock {
            require(id.matches(Regex("[a-z0-9]{5}")))
            val text = normalize(memory)
            require(text.isNotBlank() && text.length <= 800) { "invalid_memory" }
            val snapshot = snapshotUnlocked()
            val note = snapshot.notes.firstOrNull { it.id == id } ?: return@withLock false
            writeCategory(note.category, snapshot.notes.filter { it.category == note.category }.map { if (it.id == id) it.copy(text = text) else it })
            val meta = loadMeta().toMutableMap()
            val now = System.currentTimeMillis() / 1000
            val entry = meta[id] ?: MetaEntry(note.created, now)
            meta[id] = entry.copy(updated = now, dated = MemoryDates.dated(note.text, text, entry.dated, now))
            writeMeta(meta)
            true
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

    // memory_recent_context() in lib/chat/context.php: limits and health
    // first, the newest few, anything due soon, then the rest by score
    suspend fun recentContext(turns: List<Pair<String, Double>>, maxChars: Int = 2500): String {
        val snapshot = snapshot()
        if (snapshot.notes.isEmpty()) return ""
        val today = LocalDate.now()
        val bullet = { note: MemoryNote ->
            val created = MemoryDates.day(note.anchor)
            "- " + MemoryDates.stamp(note.text, created) + MemoryDates.render(note.text, created).replace(WIKI_LINK, "$1")
        }
        val picked = LinkedHashMap<String, MemoryNote>()
        var room = maxChars * PINNED_SHARE_PERCENT / 100
        for (note in snapshot.notes.filter { it.category in PINNED }.sortedWith(compareBy<MemoryNote> { PINNED.indexOf(it.category) }.thenByDescending { it.updated })) {
            val size = bullet(note).length
            if (size > room) break
            room -= size
            picked[note.id] = note
        }
        var rest = snapshot.notes.filter { it.id !in picked }.sortedByDescending { it.updated }
        rest.take(RECENT_KEEP).forEach { picked[it.id] = it }
        for (note in rest) {
            if (MemoryDates.days(note.text, MemoryDates.day(note.anchor)).any { java.time.temporal.ChronoUnit.DAYS.between(today, it) in SOON_FROM..SOON_TO }) {
                picked.putIfAbsent(note.id, note)
            }
        }
        rest = rest.filter { it.id !in picked }
        val scores = if (turns.isEmpty()) emptyMap() else retrieval.score(
            retrieval.index(rest.map { mapOf("t" to it.category + " " + it.text) }, linkedMapOf("t" to 1.0)),
            retrieval.query(turns),
        ).associate { it.doc to it.score }
        val now = System.currentTimeMillis() / 1000
        rest.mapIndexed { i, note -> note to (scores[i] ?: 0.0) + Math.pow(0.5, maxOf(0L, now - note.updated) / 86400.0 / HALF_LIFE_DAYS) }
            .sortedByDescending { it.second }
            .forEach { (note, _) -> picked[note.id] = note }

        val chosen = mutableMapOf<String, MutableList<MemoryNote>>()
        var size = CONTEXT_HEADER.length
        for (note in picked.values) {
            val cost = bullet(note).length + 1 + if (note.category in chosen) 0 else note.category.length + 7
            if (size + cost > maxChars) continue
            chosen.getOrPut(note.category) { mutableListOf() } += note
            size += cost
        }
        if (chosen.isEmpty()) return ""
        val order = snapshot.notes.withIndex().associate { it.value.id to it.index }
        val sections = chosen.entries.sortedByDescending { (_, notes) -> notes.maxOf { it.updated } }.map { (category, notes) ->
            "### $category\n" + notes.sortedBy { order[it.id] }.joinToString("\n", transform = bullet)
        }
        return CONTEXT_HEADER + "\n" + sections.joinToString("\n\n")
    }

    // recall_notes() / recall_journal() in lib/chat/recall.php, for search_recent_chats
    suspend fun search(query: com.efficiencyx.junos.retrieval.Query, enough: (List<String>) -> Boolean): Pair<List<Map<String, String>>, List<Map<String, String>>> {
        val snapshot = snapshot()
        val notes = if (snapshot.notes.isEmpty()) emptyList() else retrieval.score(
            retrieval.index(snapshot.notes.map { mapOf("t" to it.text) }, linkedMapOf("t" to 1.0)), query,
        ).filter { enough(it.matched) }.take(RECALL_NOTES_MAX).map { hit ->
            val note = snapshot.notes[hit.doc]
            val created = MemoryDates.day(note.anchor)
            mapOf("category" to note.category, "note" to MemoryDates.stamp(note.text, created) + MemoryDates.render(note.text, created))
        }
        val entries = snapshot.journal.entries
        val journal = if (entries.isEmpty()) emptyList() else retrieval.score(
            retrieval.index(entries.map { mapOf("t" to it.text) }, linkedMapOf("t" to 1.0)), query,
        ).filter { enough(it.matched) }.take(RECALL_JOURNAL_MAX).map { mapOf("date" to entries[it.doc].date, "entry" to entries[it.doc].text) }
        return notes to journal
    }

    suspend fun journalText(): String = withContext(Dispatchers.IO) {
        mutex.withLock { File(root, "journal.md").takeIf { it.isFile }?.readText()?.trim().orEmpty() }
    }

    // write_journal. php's memory_journal_append(), in this file's
    // own "## date" layout. null when it went in, else the error
    suspend fun appendJournal(entry: String, day: LocalDate = LocalDate.now()): String? = withContext(Dispatchers.IO) {
        mutex.withLock {
            val text = normalize(entry).take(JOURNAL_ENTRY_MAX)
            if (text.isBlank()) return@withLock "journal_text_required"
            val date = day.toString()
            val entries = parseJournal().toMutableList()
            val at = entries.indexOfFirst { it.date == date }
            val merged = if (at >= 0) entries[at].text + " " + text else text
            if (merged.length > JOURNAL_DAY_MAX) return@withLock "journal_day_full"
            if (at >= 0) entries[at] = JournalEntry(date, merged) else entries += JournalEntry(date, merged)
            atomicWrite(
                File(root, "journal.md"),
                entries.sortedByDescending { it.date }.joinToString("\n\n", postfix = "\n") { "## ${it.date}\n${it.text}" },
            )
            null
        }
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
            MemoryNote(id, slug, match.groupValues[1].trim(), links(match.groupValues[1]), stamp.created, stamp.updated, stamp.source, dated = stamp.dated)
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
        private val PINNED = listOf("boundaries", "health")
        // 700 of the 2500 chars on the PC, the same share of the phone's 1200
        private const val PINNED_SHARE_PERCENT = 28
        private const val RECENT_KEEP = 3
        private const val SOON_FROM = -1L
        private const val SOON_TO = 3L
        private const val HALF_LIFE_DAYS = 30.0
        private const val RECALL_NOTES_MAX = 4
        private const val RECALL_JOURNAL_MAX = 2
        private const val JOURNAL_ENTRY_MAX = 400
        private const val JOURNAL_DAY_MAX = 1600
        private val CATEGORIES = setOf("preferences", "work", "health", "family", "plans", "boundaries", "events")
        private val NOTE_LINE = Regex("^-\\s+(.+?)\\s+\\^([a-z0-9]{5})$")
        private val WIKI_LINK = Regex("\\[\\[([^]\\n]+)]]")
        private val JOURNAL_HEADING = Regex("^##\\s+(\\d{4}-\\d{2}-\\d{2})$")

        // Word for word what memory_recent_context() in webapp/api/lib/chat/context.php puts
        // in front of the notes, she reads the same block on both sides.
        private const val CONTEXT_HEADER = "## Durable memory notes\n" +
            "Words like \"tomorrow\" or \"next friday\" in a note mean the day you wrote it, not now. " +
            "Where a note already spells the real day out in brackets, use that day and trust it - " +
            "do not work the date out again yourself."
    }
}
