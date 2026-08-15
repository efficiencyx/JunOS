package com.efficiencyx.junos.setup

import android.content.Context
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

@Serializable
data class ModelSpec(
    val id: String,
    @SerialName("display_name") val displayName: String,
    val repository: String,
    val quant: String,
    val filename: String,
    @SerialName("download_url") val downloadUrl: String,
    val size: Long,
    val sha256: String,
) {
    fun pinned(): Boolean =
        downloadUrl.startsWith("https://") && sha256.matches(Regex("[a-fA-F0-9]{64}")) && size > 0
}

@Serializable
data class VoicePackSpec(
    val id: String,
    @SerialName("archive_url") val archiveUrl: String,
    val size: Long,
    val sha256: String,
)

@Serializable
data class VoiceManifest(val kokoro: VoicePackSpec, val asr: VoicePackSpec)

class ModelStore(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder().followRedirects(true).followSslRedirects(true).build()
    private val root = File(context.filesDir, "models").also { it.mkdirs() }
    val litertModelFile: File get() = File(root, "jun.litertlm")
    val litertCacheDir: File get() = File(root, "litert-cache").also { it.mkdirs() }
    val voiceRoot: File get() = File(root, "voice").also { it.mkdirs() }

    fun modelReady(): Boolean = litertReady()
    fun litertReady(): Boolean = litertModelFile.isFile && litertModelFile.length() > 64L * 1024 * 1024
    fun voiceReady(): Boolean = File(voiceRoot, ".ready").isFile

    fun litertSpec(): ModelSpec? = runCatching {
        context.assets.open("manifests/litert_model.json").bufferedReader().use {
            json.decodeFromString<ModelSpec>(it.readText())
        }
    }.getOrNull()?.takeIf { it.pinned() }

    fun voiceManifest(): VoiceManifest = context.assets.open("manifests/voice.json").bufferedReader().use {
        json.decodeFromString(it.readText())
    }

    suspend fun downloadModel(progress: (Long, Long) -> Unit) = withContext(Dispatchers.IO) {
        val spec = litertSpec() ?: error("The Jun LiteRT bundle has not been pinned with a URL and checksum yet.")
        download(spec.downloadUrl, litertModelFile, spec.size, spec.sha256, progress)
    }

    suspend fun downloadVoice(progress: (Long, Long) -> Unit) = withContext(Dispatchers.IO) {
        val manifest = voiceManifest()
        val packs = listOf(manifest.kokoro, manifest.asr)
        check(packs.all { it.archiveUrl.startsWith("https://") && it.size > 0 && it.sha256.matches(Regex("[a-fA-F0-9]{64}")) })
        val work = File(context.cacheDir, "voice-install")
        work.mkdirs()
        val archives = mutableListOf<File>()
        var offset = 0L
        try {
            for (pack in packs) {
                val archive = File(work, "${pack.id}.tar.bz2")
                download(pack.archiveUrl, archive, pack.size, pack.sha256) { done, _ ->
                    progress(offset + done, packs.sumOf { it.size })
                }
                archives += archive
                offset += pack.size
            }
            val incoming = File(voiceRoot.parentFile, "voice.incoming")
            deleteInside(incoming, voiceRoot.parentFile!!)
            incoming.mkdirs()
            if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
            // keep jun_voice seperate from jun_recovery. importing the
            // latter drags UnityPy and Pillow into a path that only needs
            // tarfile.
            Python.getInstance().getModule("jun_voice")
                .callAttr("extract_voice", archives.map { it.absolutePath }.toTypedArray(), incoming.absolutePath)
            check(File(incoming, "kokoro-en-v0_19/model.onnx").isFile)
            check(File(incoming, "sherpa-onnx-whisper-tiny.en/tiny.en-encoder.int8.onnx").isFile)
            File(incoming, ".ready").writeText("voice-manifest-v1\n")
            val old = File(voiceRoot.parentFile, "voice.old")
            deleteInside(old, voiceRoot.parentFile!!)
            if (voiceRoot.exists()) check(voiceRoot.renameTo(old))
            if (!incoming.renameTo(voiceRoot)) {
                old.renameTo(voiceRoot)
                error("Could not activate voice models")
            }
            deleteInside(old, voiceRoot.parentFile!!)
        } finally {
            deleteInside(work, context.cacheDir)
        }
    }

    suspend fun download(
        url: String,
        destination: File,
        expectedSize: Long,
        expectedSha256: String,
        progress: (Long, Long) -> Unit,
    ) = withContext(Dispatchers.IO) {
        destination.parentFile?.mkdirs()
        val partial = File(destination.parentFile, destination.name + ".part")
        val existing = partial.takeIf { it.isFile }?.length() ?: 0L
        val request = Request.Builder().url(url).apply {
            if (existing > 0) header("Range", "bytes=$existing-")
        }.build()
        client.newCall(request).execute().use { response ->
            check(response.isSuccessful || response.code == 206) { "Download failed: HTTP ${response.code}" }
            val append = existing > 0 && response.code == 206
            val start = if (append) existing else 0L
            val total = response.body?.contentLength()?.takeIf { it >= 0 }?.plus(start) ?: expectedSize
            FileOutputStream(partial, append).use { output ->
                val input = response.body?.byteStream() ?: error("Download returned no body")
                val buffer = ByteArray(256 * 1024)
                var written = start
                while (true) {
                    coroutineContext.ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    written += count
                    progress(written, total)
                }
                output.fd.sync()
            }
        }
        check(expectedSize <= 0 || partial.length() == expectedSize) { "Downloaded model has the wrong size" }
        check(sha256(partial).equals(expectedSha256, ignoreCase = true)) { "Downloaded model checksum does not match" }
        check(partial.renameTo(destination)) { "Could not install downloaded model" }
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

    private fun deleteInside(target: File, parent: File) {
        if (!target.exists()) return
        val safe = target.canonicalFile
        check(safe.path.startsWith(parent.canonicalPath + File.separator))
        safe.walkBottomUp().forEach { it.delete() }
    }
}
