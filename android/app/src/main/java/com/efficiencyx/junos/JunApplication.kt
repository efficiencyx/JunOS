package com.efficiencyx.junos

import android.app.Application
import com.efficiencyx.junos.colab.ColabSession
import com.efficiencyx.junos.data.JunDatabase
import com.efficiencyx.junos.inference.ChatEngine
import com.efficiencyx.junos.inference.InferenceEngine
import com.efficiencyx.junos.inference.LiteRtEngine
import com.efficiencyx.junos.lore.LoreIndex
import com.efficiencyx.junos.memory.MemoryStore
import com.efficiencyx.junos.pairing.PairingStore
import com.efficiencyx.junos.server.LocalServer
import com.efficiencyx.junos.setup.AssetRecovery
import com.efficiencyx.junos.setup.ModelStore
import com.efficiencyx.junos.voice.VoiceEngine

class JunApplication : Application() {
    val database by lazy { JunDatabase.create(this) }
    val modelStore by lazy { ModelStore(this) }
    val memoryStore by lazy { MemoryStore(this) }
    val loreIndex by lazy { LoreIndex(this) }
    val pairingStore by lazy { PairingStore(this) }
    val colab by lazy { ColabSession(this) }
    val localEngine by lazy { LiteRtEngine(modelStore) }
    @Volatile private var sessionEngine: InferenceEngine? = null
    val inferenceEngine: InferenceEngine get() = sessionEngine ?: localEngine
    val voiceEngine by lazy { VoiceEngine(this, modelStore) }
    val chatEngine by lazy {
        ChatEngine(this, database, memoryStore, loreIndex) { inferenceEngine }
    }
    val assetRecovery by lazy { AssetRecovery(this) }
    val localServer by lazy {
        LocalServer(this, database, memoryStore, chatEngine, voiceEngine, assetRecovery)
    }

    // one per launch. closing the old one is what frees LiteRT's weights
    fun useEngine(engine: InferenceEngine) {
        val old = inferenceEngine
        sessionEngine = engine
        if (old !== engine) old.close()
    }

    override fun onTerminate() {
        localServer.stop()
        inferenceEngine.close()
        voiceEngine.close()
        super.onTerminate()
    }
}
