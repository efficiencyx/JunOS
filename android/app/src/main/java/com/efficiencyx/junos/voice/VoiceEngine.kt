package com.efficiencyx.junos.voice

import android.content.Context
import com.efficiencyx.junos.setup.ModelStore
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

@Serializable
data class TtsRequest(
    val text: String,
    val voice: String? = null,
    val engine: String? = null,
    val lang: String? = null,
    val speed: Float = 1f,
)

class VoiceEngine(
    @Suppress("UNUSED_PARAMETER") context: Context,
    private val models: ModelStore,
) : AutoCloseable {
    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var idleJob: Job? = null
    private var tts: OfflineTts? = null
    private var recognizer: OfflineRecognizer? = null

    val available: Boolean get() = models.voiceReady()

    fun voices(): JsonObject = buildJsonObject {
        val voiceList = if (available) VOICES.keys.toList() else emptyList()
        put("engines", buildJsonObject {
            put("kokoro", buildJsonObject {
                put("voices", JsonArray(voiceList.map(::JsonPrimitive)))
                put("default", DEFAULT_VOICE)
                put("available", available)
            })
        })
        put("default_engine", "kokoro")
    }

    suspend fun warm() = withContext(Dispatchers.Default) {
        if (!available) return@withContext
        mutex.withLock { ensureTts(); scheduleUnload() }
    }

    suspend fun synthesize(request: TtsRequest): ByteArray = withContext(Dispatchers.Default) {
        require(request.text.isNotBlank() && request.text.length <= 2000) { "invalid_request" }
        require(request.engine == null || request.engine == "kokoro") { "invalid_request" }
        require(request.speed in 0.5f..2f) { "invalid_request" }
        check(available) { "voice_pack_not_installed" }
        mutex.withLock {
            val engine = ensureTts()
            val sid = VOICES[request.voice] ?: VOICES.getValue(DEFAULT_VOICE)
            val audio = engine.generate(request.text, sid, request.speed)
            check(audio.samples.isNotEmpty()) { "tts_failed" }
            scheduleUnload()
            encodeWav(audio.samples, audio.sampleRate)
        }
    }

    suspend fun transcribe(wav: ByteArray): String = withContext(Dispatchers.Default) {
        check(available) { "voice_pack_not_installed" }
        val audio = decodeWav(wav)
        require(audio.sampleRate == 16_000) { "stt_requires_16khz_wav" }
        mutex.withLock {
            val engine = ensureRecognizer()
            val stream = engine.createStream()
            try {
                stream.acceptWaveform(audio.samples, audio.sampleRate)
                engine.decode(stream)
                engine.getResult(stream).text.trim()
            } finally {
                stream.release()
                scheduleUnload()
            }
        }
    }

    private fun ensureTts(): OfflineTts {
        tts?.let { return it }
        val root = models.voiceRoot.resolve("kokoro-en-v0_19")
        val config = OfflineTtsConfig(
            model = OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = root.resolve("model.onnx").absolutePath,
                    voices = root.resolve("voices.bin").absolutePath,
                    tokens = root.resolve("tokens.txt").absolutePath,
                    dataDir = root.resolve("espeak-ng-data").absolutePath,
                ),
                numThreads = 2,
                provider = "cpu",
            ),
            maxNumSentences = 2,
        )
        return OfflineTts(config = config).also { tts = it }
    }

    private fun ensureRecognizer(): OfflineRecognizer {
        recognizer?.let { return it }
        val root = models.voiceRoot.resolve("sherpa-onnx-whisper-tiny.en")
        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80),
            modelConfig = OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = root.resolve("tiny.en-encoder.int8.onnx").absolutePath,
                    decoder = root.resolve("tiny.en-decoder.int8.onnx").absolutePath,
                    language = "en",
                    task = "transcribe",
                ),
                tokens = root.resolve("tiny.en-tokens.txt").absolutePath,
                numThreads = 2,
                provider = "cpu",
                modelType = "whisper",
            ),
        )
        return OfflineRecognizer(config = config).also { recognizer = it }
    }

    private fun scheduleUnload() {
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(IDLE_UNLOAD_MS)
            mutex.withLock { unload() }
        }
    }

    private fun unload() {
        tts?.release(); tts = null
        recognizer?.release(); recognizer = null
    }

    override fun close() {
        scope.cancel()
        unload()
    }

    private data class Pcm(val samples: FloatArray, val sampleRate: Int)

    private fun decodeWav(bytes: ByteArray): Pcm {
        require(bytes.size in 44..4 * 1024 * 1024) { "invalid_wav" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(readAscii(buffer, 4) == "RIFF") { "invalid_wav" }
        buffer.int
        require(readAscii(buffer, 4) == "WAVE") { "invalid_wav" }
        var channels = 0
        var sampleRate = 0
        var bits = 0
        var format = 0
        var dataOffset = -1
        var dataSize = 0
        while (buffer.remaining() >= 8) {
            val id = readAscii(buffer, 4)
            val size = buffer.int
            require(size >= 0 && size <= buffer.remaining()) { "invalid_wav" }
            val start = buffer.position()
            if (id == "fmt " && size >= 16) {
                format = buffer.short.toInt() and 0xffff
                channels = buffer.short.toInt() and 0xffff
                sampleRate = buffer.int
                buffer.int; buffer.short
                bits = buffer.short.toInt() and 0xffff
            } else if (id == "data") {
                dataOffset = start
                dataSize = size
            }
            buffer.position(start + size + (size and 1).coerceAtMost(buffer.limit() - start - size))
        }
        require(format == 1 && channels in 1..2 && bits == 16 && sampleRate in 8_000..48_000 && dataOffset >= 0) { "unsupported_wav" }
        val pcm = ByteBuffer.wrap(bytes, dataOffset, dataSize).order(ByteOrder.LITTLE_ENDIAN)
        val frames = dataSize / 2 / channels
        val samples = FloatArray(frames)
        for (frame in 0 until frames) {
            var sum = 0f
            repeat(channels) { sum += pcm.short / 32768f }
            samples[frame] = sum / channels
        }
        return Pcm(samples, sampleRate)
    }

    private fun encodeWav(samples: FloatArray, sampleRate: Int): ByteArray {
        val dataSize = samples.size * 2
        val output = ByteArrayOutputStream(44 + dataSize)
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + dataSize).put("WAVEfmt ".toByteArray())
        header.putInt(16).putShort(1).putShort(1).putInt(sampleRate).putInt(sampleRate * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(dataSize)
        output.write(header.array())
        val pcm = ByteBuffer.allocate(dataSize).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach { pcm.putShort((it.coerceIn(-1f, 1f) * 32767f).roundToInt().toShort()) }
        output.write(pcm.array())
        return output.toByteArray()
    }

    private fun readAscii(buffer: ByteBuffer, count: Int): String {
        val value = ByteArray(count); buffer.get(value); return value.toString(Charsets.US_ASCII)
    }

    companion object {
        private const val DEFAULT_VOICE = "af_heart"
        private const val IDLE_UNLOAD_MS = 2 * 60 * 1000L
        private val VOICES = linkedMapOf(
            "af" to 0, "af_heart" to 0, "af_bella" to 1, "af_nicole" to 2, "af_sarah" to 3,
            "af_sky" to 4, "am_adam" to 5, "am_michael" to 6, "bf_emma" to 7,
            "bf_isabella" to 8, "bm_george" to 9, "bm_lewis" to 10,
        )
    }
}
