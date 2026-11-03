package com.efficiencyx.junos.pairing

import android.util.Base64
import com.efficiencyx.junos.BuildConfig
import com.efficiencyx.junos.inference.RemoteError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// the Codex CLI's OAuth app. its redirect is registered as
// localhost:1455 and NOTHING else, so the phone listens there
object ChatGptLogin {
    private const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
    private const val ISSUER = "https://auth.openai.com"
    private const val PORT = 1455
    private const val REDIRECT = "http://localhost:$PORT/auth/callback"
    private const val TIMEOUT_MS = 5 * 60 * 1000
    private const val RETURN = "junos://signed-in"

    // package= or debug and release both claim junos:// and android asks which one
    private val returnIntent = "intent://signed-in#Intent;scheme=junos;package=${BuildConfig.APPLICATION_ID};end"

    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    class Session(val verifier: String, val state: String, val authorizeUrl: String)

    fun begin(): Session {
        val verifier = random(64)
        val state = random(32)
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val query = listOf(
            "response_type" to "code",
            "client_id" to CLIENT_ID,
            "redirect_uri" to REDIRECT,
            "scope" to "openid profile email offline_access",
            "code_challenge" to challenge,
            "code_challenge_method" to "S256",
            "id_token_add_organizations" to "true",
            "codex_cli_simplified_flow" to "true",
            "state" to state,
            "originator" to ORIGINATOR,
        ).joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
        return Session(verifier, state, "$ISSUER/oauth/authorize?$query")
    }

    // both loopbacks: chrome tries ::1 first for "localhost"
    suspend fun awaitCode(session: Session): String = withContext(Dispatchers.IO) {
        val sockets = listOf("127.0.0.1", "::1").mapNotNull { host ->
            runCatching {
                ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(InetAddress.getByName(host), PORT))
                }
            }.getOrNull()
        }
        if (sockets.isEmpty()) throw RemoteError("chatgpt_port_busy")
        val result = CompletableDeferred<String>()
        sockets.forEach { server -> thread(isDaemon = true) { acceptAll(server, session.state, result) } }
        // accept() never sees cancellation, closing the sockets is the only way out
        try {
            withTimeoutOrNull(TIMEOUT_MS.toLong()) { result.await() } ?: throw RemoteError("chatgpt_cancelled")
        } finally {
            sockets.forEach { runCatching { it.close() } }
        }
    }

    // one thread per connection. chrome preconnects a socket and sends NOTHING on it,
    // serving them in turn blocks on that one while the real callback waits behind it
    private fun acceptAll(server: ServerSocket, state: String, result: CompletableDeferred<String>) {
        while (true) {
            val client = try { server.accept() } catch (_: IOException) { return }
            thread(isDaemon = true) {
                runCatching { client.use { serve(it, state, result) } }
            }
        }
    }

    private fun serve(socket: Socket, state: String, result: CompletableDeferred<String>) {
        socket.soTimeout = 60_000
        val head = socket.getInputStream().bufferedReader().readLine().orEmpty()
        val target = head.split(' ').getOrNull(1).orEmpty()
        val params = target.substringAfter('?', "").split('&').associate {
            it.substringBefore('=') to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
        }
        val code = params["code"]
        val ok = target.startsWith("/auth/callback") && params["state"] == state && !code.isNullOrEmpty()
        // the redirect brings MainActivity (singleTask) back, which drops the custom tab on top of it
        val response = if (ok) {
            "HTTP/1.1 302 Found\r\nLocation: $returnIntent\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        } else {
            val body = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><body style=\"font:18px sans-serif;padding:32px\">That sign-in didn't work. Go back to Jun OS and try again."
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body"
        }
        socket.getOutputStream().write(response.toByteArray())
        if (ok) result.complete(code!!)
        else if (target.startsWith("/auth/callback") && params["error"] != null) result.completeExceptionally(RemoteError("chatgpt_cancelled"))
    }

    suspend fun exchange(session: Session, code: String, model: String): Pairing = withContext(Dispatchers.IO) {
        val tokens = post(
            FormBody.Builder()
                .add("grant_type", "authorization_code")
                .add("code", code)
                .add("redirect_uri", REDIRECT)
                .add("client_id", CLIENT_ID)
                .add("code_verifier", session.verifier)
                .build(),
        )
        pairing(tokens, model, previous = null)
    }

    suspend fun refresh(pairing: Pairing): Pairing = withContext(Dispatchers.IO) {
        val refresh = pairing.refresh ?: throw RemoteError("unauthorized")
        val tokens = post(
            FormBody.Builder()
                .add("grant_type", "refresh_token")
                .add("refresh_token", refresh)
                .add("client_id", CLIENT_ID)
                .build(),
        )
        pairing(tokens, pairing.model.orEmpty(), previous = pairing)
    }

    fun isReturn(link: String) = link.startsWith(RETURN)

    fun needsRefresh(pairing: Pairing): Boolean = pairing.expires - System.currentTimeMillis() < 120_000

    private fun post(form: FormBody): JsonObject {
        val request = Request.Builder().url("$ISSUER/oauth/token").post(form).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 400 || response.code == 401) throw RemoteError("unauthorized")
            if (!response.isSuccessful) throw RemoteError("chatgpt_unreachable")
            return json.parseToJsonElement(response.body.string()).jsonObject
        }
    }

    private fun pairing(tokens: JsonObject, model: String, previous: Pairing?): Pairing {
        val access = tokens["access_token"]?.jsonPrimitive?.contentOrNull ?: throw RemoteError("unauthorized")
        val refresh = tokens["refresh_token"]?.jsonPrimitive?.contentOrNull ?: previous?.refresh
        val ttl = tokens["expires_in"]?.jsonPrimitive?.intOrNull ?: 3600
        val claims = listOfNotNull(tokens["id_token"]?.jsonPrimitive?.contentOrNull, access).mapNotNull(::authClaims)
        val account = claims.firstNotNullOfOrNull { it["chatgpt_account_id"]?.jsonPrimitive?.contentOrNull }
            ?: previous?.account
        return Pairing(
            mode = SessionMode.API,
            name = "ChatGPT",
            urls = listOf("https://chatgpt.com"),
            token = access,
            api = "chatgpt",
            model = model,
            ctx = previous?.ctx ?: 32768,
            refresh = refresh,
            account = account,
            expires = System.currentTimeMillis() + ttl * 1000L,
        )
    }

    private fun authClaims(jwt: String): JsonObject? = runCatching {
        val payload = jwt.split('.')[1]
        val claims = json.parseToJsonElement(String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))).jsonObject
        claims["https://api.openai.com/auth"]!!.jsonObject
    }.getOrNull()

    private fun random(bytes: Int) = b64(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    const val ORIGINATOR = "junos"
}
