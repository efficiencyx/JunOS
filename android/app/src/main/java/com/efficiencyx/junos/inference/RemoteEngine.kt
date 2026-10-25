package com.efficiencyx.junos.inference

import com.efficiencyx.junos.pairing.Pairing
import com.efficiencyx.junos.pairing.PairingStore
import com.efficiencyx.junos.pairing.SessionMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// her brain on the PC (LAN) or the notebook's tunnel (Cloud). chats,
// memory and the whole prompt stay on the phone either way
class RemoteEngine(private val pairing: Pairing, private val store: PairingStore) : InferenceEngine {
    private val loadMutex = Mutex()
    private val _state = MutableStateFlow<EngineState>(EngineState.Idle)
    private val _lastStats = MutableStateFlow<JsonObject?>(null)
    @Volatile private var base: String? = null
    @Volatile private var client: OkHttpClient? = null
    @Volatile private var active: Call? = null
    @Volatile private var window = pairing.ctx ?: 8192

    override val state: StateFlow<EngineState> = _state.asStateFlow()
    override val lastStats: StateFlow<JsonObject?> = _lastStats.asStateFlow()
    override val label: String = pairing.name
    override val contextTokens: Int get() = window
    private val unreachable = if (pairing.mode == SessionMode.LAN) "lan_unreachable" else "cloud_unreachable"

    override suspend fun ensureLoaded(): Unit = loadMutex.withLock {
        if (base != null) return
        _state.value = EngineState.Loading(0f)
        try {
            withContext(Dispatchers.IO) { connect() }
        } catch (error: Throwable) {
            _state.value = EngineState.Failed(error.message ?: unreachable)
            throw error
        }
        _state.value = EngineState.Ready(pairing.api, pairing.host)
    }

    // every address the QR listed, in order. a 401 isn't an address
    // problem, the next one would say the same
    private fun connect() {
        val http = httpClient()
        var last: Throwable? = null
        for (url in pairing.urls) {
            try {
                val request = Request.Builder().url(RemoteWire.probeUrl(pairing.api, url)).authorized().build()
                http.newBuilder().callTimeout(10, TimeUnit.SECONDS).build().newCall(request).execute().use { response ->
                    checkStatus(response.code)
                    response.body.string().let { body ->
                        runCatching { Json.parseToJsonElement(body) }.getOrNull()?.ctxFromProbe(pairing.api)?.let { window = it }
                    }
                }
                base = url
                client = http
                return
            } catch (error: SSLException) {
                last = RemoteError("certificate_mismatch", error)
            } catch (error: IOException) {
                last = error
            }
        }
        throw last as? RemoteError ?: RemoteError(unreachable, last)
    }

    private fun checkStatus(code: Int) {
        when {
            code == 401 || code == 403 -> throw RemoteError("unauthorized")
            code == 404 && pairing.api == "jun" -> throw RemoteError("lan_mode_off")
            code >= 400 -> throw IOException("http $code")
        }
    }

    override fun generate(messages: List<ChatMessage>, maxTokens: Int, temperature: Float): Flow<String> =
        turn(messages, emptyList(), false, maxTokens, temperature).mapNotNull { (it as? TurnEvent.Text)?.text }

    override fun turn(
        messages: List<ChatMessage>,
        tools: List<String>,
        think: Boolean,
        maxTokens: Int,
        temperature: Float,
        reasoning: String,
    ): Flow<TurnEvent> = flow {
        ensureLoaded()
        val body = RemoteWire.request(pairing.api, pairing.model, messages, tools, think, maxTokens, temperature, reasoning, window)
        val request = Request.Builder().url(RemoteWire.chatUrl(pairing.api, base!!)).authorized()
            .post(body.toString().toRequestBody(JSON)).build()
        val call = client!!.newCall(request)
        active = call
        currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
        _state.value = EngineState.Prefill(messages.sumOf { it.content.length } / 4)
        val started = System.nanoTime()
        val parser = StreamParser(ollama = pairing.api == "ollama")
        try {
            call.execute().use { response ->
                checkStatus(response.code)
                val source = response.body.source()
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    for (event in parser.line(line)) emit(event)
                }
            }
            for (event in parser.finish()) emit(event)
        } catch (error: IOException) {
            if (call.isCanceled()) throw error
            throw RemoteError("connection_lost", error)
        } finally {
            active = null
            _lastStats.value = parser.stats((System.nanoTime() - started) / 1_000_000)
            _state.value = EngineState.Ready(pairing.api, pairing.host)
        }
    }.flowOn(Dispatchers.IO)

    override fun cancel() {
        active?.cancel()
        active = null
    }

    override fun close() {
        cancel()
        client?.connectionPool?.evictAll()
        client = null
        base = null
        _state.value = EngineState.Idle
    }

    private fun Request.Builder.authorized() = header("Authorization", "Bearer ${pairing.token}")

    private fun httpClient(): OkHttpClient {
        // idle = the gap between two tokens. a cold model on a CPU box
        // reads a long prompt for minutes before the first one
        val builder = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(300, TimeUnit.SECONDS)
        val pin = pairing.ca ?: return builder.build()
        val pem = store.caPem(pin) ?: fetchCa(pin).also { store.saveCa(pin, it) }
        val trust = onlyTrust(certificate(pem))
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return builder.sslSocketFactory(ssl.socketFactory, trust).build()
    }

    // no CA to check this connection with yet, so it's unchecked. fine:
    // the file only counts if its hash is the QR's, and the token
    // isn't sent until it's pinned
    private fun fetchCa(pin: String): String {
        val loose = SSLContext.getInstance("TLS").apply { init(null, arrayOf(AcceptForHashCheck), null) }
        val http = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
            .sslSocketFactory(loose.socketFactory, AcceptForHashCheck).hostnameVerifier { _, _ -> true }.build()
        var last: Throwable? = null
        for (url in pairing.urls) {
            val origin = URI(url).let { "https://${it.rawAuthority}" }
            val pem = try {
                http.newCall(Request.Builder().url("$origin/jun-ca.pem").build()).execute().use { response ->
                    if (response.isSuccessful) response.body.string() else null
                }
            } catch (error: IOException) {
                last = error
                null
            } ?: continue
            val cert = runCatching { certificate(pem) }.getOrNull() ?: continue
            if (sha256(cert.encoded) == pin) return pem
            throw RemoteError("ca_changed")
        }
        throw RemoteError(unreachable, last)
    }

    private object AcceptForHashCheck : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private companion object {
        val JSON = "application/json".toMediaType()

        fun certificate(pem: String): X509Certificate =
            CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate

        fun onlyTrust(ca: X509Certificate): X509TrustManager {
            val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null)
                setCertificateEntry("jun", ca)
            }
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }
            return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        }

        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
