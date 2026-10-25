package com.efficiencyx.junos.pairing

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder

enum class SessionMode { LOCAL, LAN, CLOUD }

// api is the wire protocol: "jun" is the desktop's api/model.php,
// "openai" vllm and "ollama" ollama, both behind the notebook's gate
@Serializable
data class Pairing(
    val mode: SessionMode,
    val name: String,
    val urls: List<String>,
    val token: String,
    val ca: String? = null,
    val api: String = "jun",
    val model: String? = null,
    val ctx: Int? = null,
) {
    val host: String get() = runCatching { URI(urls.first()).host }.getOrNull() ?: name

    companion object {
        private val TOKEN = Regex("[A-Za-z0-9_-]{32,256}")
        private val FINGERPRINT = Regex("[0-9a-fA-F]{64}")

        fun parse(link: String): Pairing? {
            val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return null
            if (!uri.scheme.equals("junos", true) || uri.rawSchemeSpecificPart?.startsWith("//pair?") != true) return null
            val params = uri.rawSchemeSpecificPart.substringAfter('?').split('&').mapNotNull { pair ->
                val key = pair.substringBefore('=', "")
                if (key.isEmpty()) null else key to URLDecoder.decode(pair.substringAfter('='), "UTF-8")
            }
            fun one(key: String) = params.lastOrNull { it.first == key }?.second

            val mode = when (one("mode")) {
                "lan" -> SessionMode.LAN
                "cloud" -> SessionMode.CLOUD
                else -> return null
            }
            val token = one("token")?.takeIf { TOKEN.matches(it) } ?: return null
            val urls = params.filter { it.first == "url" }.map { it.second }.take(8)
            if (urls.isEmpty() || !urls.all(::isHttpsUrl)) return null
            val ca = one("ca")?.let { if (FINGERPRINT.matches(it)) it.lowercase() else return null }
            val api = one("api") ?: "jun"
            if (api !in setOf("jun", "openai", "ollama")) return null
            if (mode == SessionMode.LAN && api != "jun") return null
            val model = one("model")?.take(200)?.takeIf { it.isNotBlank() }
            if (api != "jun" && model == null) return null
            val ctx = one("ctx")?.toIntOrNull()?.takeIf { it in 2048..1_048_576 }
            val name = one("name")?.replace(Regex("[\\x00-\\x1F\\x7F]"), "")?.trim()?.take(64)?.ifBlank { null }
                ?: if (mode == SessionMode.LAN) "PC" else "Cloud"
            return Pairing(mode, name, urls, token, ca, api, model, ctx)
        }

        private fun isHttpsUrl(raw: String): Boolean {
            val uri = runCatching { URI(raw) }.getOrNull() ?: return false
            return uri.scheme.equals("https", true) && !uri.host.isNullOrBlank() && uri.rawUserInfo == null
        }
    }
}
