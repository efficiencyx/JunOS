package com.efficiencyx.junos.pairing

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// the token is the whole lock on her brain, so the pairings sit
// AES-GCM encrypted under a keystore key that never leaves the phone
class PairingStore(context: Context) {
    private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var lastMode: SessionMode
        get() = runCatching { SessionMode.valueOf(prefs.getString("last_mode", null)!!) }.getOrDefault(SessionMode.LOCAL)
        set(value) = prefs.edit().putString("last_mode", value.name).apply()

    fun get(mode: SessionMode): Pairing? {
        val sealed = prefs.getString(mode.name, null) ?: return null
        return runCatching { json.decodeFromString<Pairing>(open(sealed)) }.getOrNull()
    }

    fun save(pairing: Pairing) {
        prefs.edit().putString(pairing.mode.name, seal(json.encodeToString(pairing))).apply()
    }

    fun caPem(fingerprint: String): String? = prefs.getString("ca_$fingerprint", null)

    fun saveCa(fingerprint: String, pem: String) {
        prefs.edit().putString("ca_$fingerprint", pem).apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    private fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    private fun open(sealed: String): String {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        return String(cipher.doFinal(bytes, 12, bytes.size - 12))
    }

    private companion object {
        const val ALIAS = "jun_pairing"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
