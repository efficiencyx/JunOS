package com.efficiencyx.junos.setup

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.coroutineContext

@Serializable
private data class RecoveredFile(val path: String, val size: Long, val sha256: String)

@Serializable
private data class RecoveryManifest(
    val version: Int = 1,
    val source: String,
    val atlasSize: Int = 2048,
    val createdAt: Long,
    val files: List<RecoveredFile>,
)

class AssetRecovery(private val context: Context) {
    private val activeDir = File(context.filesDir, "web-assets")
    private val json = Json { prettyPrint = true }

    fun assetsReady(): Boolean = REQUIRED_OUTPUTS.all { File(activeDir, it).isFile } &&
        File(activeDir, "asset-manifest.json").isFile

    fun assetFile(relativePath: String): File? {
        val candidate = File(activeDir, relativePath).canonicalFile
        return candidate.takeIf { it.path.startsWith(activeDir.canonicalPath + File.separator) && it.isFile }
    }

    suspend fun recover(uri: Uri, progress: (Long, Long, String) -> Unit) = withContext(Dispatchers.IO) {
        val jobId = UUID.randomUUID().toString()
        val workRoot = File(context.cacheDir, "asset-recovery/$jobId")
        val gameRoot = File(workRoot, "game")
        val output = File(workRoot, "output")
        Log.i(TAG, "Asset recovery started")
        try {
            gameRoot.mkdirs()
            output.mkdirs()
            progress(0, 10, "Checking game ZIP")
            val sourceLabel = extractUnityData(uri, gameRoot) { done, total ->
                progress(done, total, "Extracting required Unity data")
            }
            coroutineContext.ensureActive()
            runPythonRecovery(gameRoot, output) { done, total, message ->
                progress(done, total, message)
            }
            validateOutput(output)
            writeManifest(output, sourceLabel)
            installAtomically(output)
            Log.i(TAG, "Asset recovery completed")
        } finally {
            deleteInside(workRoot, context.cacheDir)
        }
    }

    private suspend fun extractUnityData(
        uri: Uri,
        gameRoot: File,
        progress: (Long, Long) -> Unit,
    ): String {
        val descriptor = context.contentResolver.openFileDescriptor(uri, "r")
            ?: error("Could not open selected ZIP")
        var prefix: String? = null
        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
            // The game ZIP keeps every entry size in a trailing data descriptor, which makes
            // ZipInputStream give up at the first stored entry. Only the central directory has
            // the sizes, so the archive has to be read by random access instead of streamed.
            val archive = try {
                ZipFile.builder().setSeekableByteChannel(input.channel).get()
            } catch (error: IOException) {
                throw IllegalStateException(
                    "Could not read the selected ZIP - copy it onto this device's storage and pick it again",
                    error,
                )
            }
            archive.use { zip ->
                val critical = mutableSetOf<String>()
                val selected = mutableListOf<Pair<ZipArchiveEntry, String>>()
                var entries = 0
                var total = 0L
                for (entry in zip.entriesInPhysicalOrder) {
                    coroutineContext.ensureActive()
                    entries++
                    if (entry.isDirectory) continue
                    val normalized = normalizeZipPath(entry.name)
                    if (normalized == "AndroidManifest.xml") error("Select the Windows or Linux game ZIP, not an Android APK")
                    val marker = "/$GAME_DATA/"
                    val at = normalized.indexOf(marker)
                    val relative = when {
                        normalized.startsWith("$GAME_DATA/") -> normalized.removePrefix("$GAME_DATA/")
                        at >= 0 -> normalized.substring(at + marker.length)
                        else -> null
                    }
                    if (relative == null || !wanted(relative)) continue
                    val currentPrefix = normalized.removeSuffix(relative).removeSuffix("/")
                    if (prefix == null) prefix = currentPrefix
                    check(prefix == currentPrefix) { "ZIP contains more than one game data directory" }
                    val base = relative.substringAfterLast('/')
                    if (base in CRITICAL) check(critical.add(base)) { "ZIP contains duplicate $base" }
                    selected += entry to relative
                    total += entry.size
                }
                Log.i(TAG, "ZIP scan completed: $entries entries, ${selected.size} selected, $total bytes")
                val missing = CRITICAL - critical
                check(missing.isEmpty()) {
                    "Unsupported game ZIP: missing ${missing.sorted().joinToString(", ")}"
                }
                check(selected.size <= MAX_FILES) { "Too many Unity resource files in ZIP" }
                check(total <= MAX_EXPANDED) { "Unity data exceeds the 3 GB recovery limit" }
                var expanded = 0L
                for ((entry, relative) in selected) {
                    val target = File(gameRoot, "$GAME_DATA/$relative").canonicalFile
                    check(target.path.startsWith(gameRoot.canonicalPath + File.separator)) { "Unsafe ZIP path" }
                    target.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { source ->
                        FileOutputStream(target).use { output ->
                            val buffer = ByteArray(1024 * 1024)
                            while (true) {
                                coroutineContext.ensureActive()
                                val read = source.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                                expanded += read
                                check(expanded <= MAX_EXPANDED) { "Unity data exceeds the 3 GB recovery limit" }
                                progress(expanded, total)
                            }
                            output.fd.sync()
                        }
                    }
                }
            }
        }
        return prefix?.substringBeforeLast("/$GAME_DATA")?.substringAfterLast('/')?.ifBlank { "official-game-zip" }
            ?: "official-game-zip"
    }

    private fun wanted(relative: String): Boolean {
        val base = relative.substringAfterLast('/')
        return base in CRITICAL || base.endsWith(".resS", true) || base.endsWith(".resource", true)
    }

    private fun normalizeZipPath(path: String): String {
        val value = path.replace('\\', '/').trim('/')
        check(value.isNotBlank() && value.split('/').none { it == ".." || it.isBlank() }) { "Unsafe ZIP path" }
        return value
    }

    private fun runPythonRecovery(gameRoot: File, output: File, progress: (Long, Long, String) -> Unit) {
        if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
        val callback = object {
            @Suppress("unused")
            fun onProgress(done: Int, total: Int, message: String) = progress(done.toLong(), total.toLong(), message)
        }
        Python.getInstance().getModule("jun_recovery")
            .callAttr("recover", gameRoot.absolutePath, output.absolutePath, callback)
    }

    private fun validateOutput(output: File) {
        for (path in REQUIRED_OUTPUTS) {
            val file = File(output, path)
            check(file.isFile && file.length() > 0) { "Recovery did not produce $path" }
        }
        for (texture in listOf("texture_00.png", "texture_01.png", "texture_02.png")) {
            File(output, texture).inputStream().use { input ->
                val signature = ByteArray(8)
                check(input.read(signature) == 8 && signature.contentEquals(PNG_SIGNATURE)) { "$texture is not a valid PNG" }
            }
        }
    }

    private fun writeManifest(output: File, source: String) {
        val files = output.walkTopDown().filter { it.isFile }.map { file ->
            RecoveredFile(file.relativeTo(output).invariantSeparatorsPath, file.length(), sha256(file))
        }.sortedBy { it.path }.toList()
        File(output, "asset-manifest.json").writeText(
            json.encodeToString(RecoveryManifest(source = source, createdAt = System.currentTimeMillis(), files = files)),
        )
    }

    private fun installAtomically(output: File) {
        val parent = activeDir.parentFile ?: error("Invalid asset directory")
        val incoming = File(parent, "web-assets.incoming")
        val old = File(parent, "web-assets.old")
        deleteInside(incoming, parent)
        check(output.renameTo(incoming)) { "Could not stage recovered assets" }
        deleteInside(old, parent)
        if (activeDir.exists()) check(activeDir.renameTo(old)) { "Could not replace existing assets" }
        if (!incoming.renameTo(activeDir)) {
            if (old.exists()) old.renameTo(activeDir)
            error("Could not activate recovered assets")
        }
        deleteInside(old, parent)
    }

    private fun deleteInside(target: File, parent: File) {
        if (!target.exists()) return
        val canonical = target.canonicalFile
        check(canonical.path.startsWith(parent.canonicalPath + File.separator))
        canonical.walkBottomUp().forEach { it.delete() }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val TAG = "JunOS"
        private const val GAME_DATA = "My Dystopian Robot Girlfriend_Data"
        private const val MAX_EXPANDED = 3L * 1024 * 1024 * 1024
        private const val MAX_FILES = 512
        private val CRITICAL = setOf("resources.assets", "sharedassets0.assets", "globalgamemanagers")
        private val REQUIRED_OUTPUTS = listOf(
            "interaction_model.moc3", "interaction_model.model3.json",
            "texture_00.png", "texture_01.png", "texture_02.png",
            "variants/limbs/mapping.json", "variants/hair/mapping.json", "variants/game_items.json",
        )
        private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    }
}
