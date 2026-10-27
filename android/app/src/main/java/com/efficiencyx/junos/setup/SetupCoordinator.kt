package com.efficiencyx.junos.setup

import android.content.Context
import android.net.Uri
import android.util.Log
import com.efficiencyx.junos.JunApplication
import com.efficiencyx.junos.inference.RemoteEngine
import com.efficiencyx.junos.inference.RemoteError
import com.efficiencyx.junos.pairing.Pairing
import com.efficiencyx.junos.pairing.SessionMode
import com.efficiencyx.junos.server.LocalServer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class SetupCoordinator(
    private val app: JunApplication,
    private val models: ModelStore,
    private val recovery: AssetRecovery,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = app.getSharedPreferences("setup", Context.MODE_PRIVATE)
    private val mutableState = MutableStateFlow(SetupState())
    val state: StateFlow<SetupState> = mutableState.asStateFlow()
    private val pairings = app.pairingStore
    private var modelJob: kotlinx.coroutines.Job? = null
    private var voiceJob: kotlinx.coroutines.Job? = null
    private var voiceSkipped = false
    private var mode = pairings.lastMode

    fun refresh() {
        val device = SystemCheck.inspect(app)
        val consented = prefs.getBoolean("adult_consent", false)
        val modelReady = models.modelReady()
        val assetsReady = recovery.assetsReady()
        val voiceReady = models.voiceReady()
        val phase = when {
            !device.supported -> SetupPhase.ERROR
            !consented -> SetupPhase.CONSENT
            !assetsReady -> SetupPhase.ASSETS
            !voiceReady && !voiceSkipped -> SetupPhase.VOICE
            else -> SetupPhase.PICK
        }
        mutableState.value = SetupState(
            phase = phase,
            device = device,
            consented = consented,
            modelReady = modelReady,
            assetsReady = assetsReady,
            voiceReady = voiceReady,
            message = phaseMessage(phase),
            error = if (!device.supported) "This build requires a 64-bit ARM phone." else null,
            mode = mode,
            lan = pairings.get(SessionMode.LAN),
            cloud = pairings.get(SessionMode.CLOUD),
            offer = mutableState.value.offer,
        )
    }

    fun skipVoice() {
        voiceSkipped = true
        refresh()
    }

    fun select(choice: SessionMode) {
        mode = choice
        mutableState.value = mutableState.value.copy(mode = choice, pickError = null)
    }

    fun offerPairing(link: String) {
        val pairing = Pairing.parse(link)
        mutableState.value = if (pairing == null) {
            mutableState.value.copy(pickError = "That isn't a Jun OS pairing code.")
        } else {
            mutableState.value.copy(offer = pairing, pickError = null)
        }
    }

    fun acceptOffer() {
        val pairing = mutableState.value.offer ?: return
        pairings.save(pairing)
        mode = pairing.mode
        mutableState.value = mutableState.value.copy(offer = null)
        refresh()
    }

    fun dismissOffer() {
        mutableState.value = mutableState.value.copy(offer = null)
    }

    fun acceptConsent() {
        prefs.edit().putBoolean("adult_consent", true).putLong("adult_consent_at", System.currentTimeMillis()).apply()
        refresh()
    }

    fun downloadModel() {
        if (modelJob?.isActive == true) return
        if (mutableState.value.device?.roomForModel == false) {
            mutableState.value = mutableState.value.copy(pickError = "The model needs at least 5 GB of free storage.")
            return
        }
        modelJob = scope.launch {
            mutableState.value = mutableState.value.copy(
                pickError = null,
                modelProgress = TransferProgress(running = true),
            )
            try {
                models.downloadModel { bytes, total ->
                    mutableState.value = mutableState.value.copy(modelProgress = TransferProgress(bytes, total, true))
                }
                refresh()
            } catch (_: CancellationException) {
                mutableState.value = mutableState.value.copy(
                    pickError = "Download paused. Your progress is saved.",
                    modelProgress = mutableState.value.modelProgress.copy(running = false),
                )
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(
                    pickError = error.message ?: "Model download failed",
                    modelProgress = mutableState.value.modelProgress.copy(running = false),
                )
            }
        }
    }

    fun pauseModelDownload() { modelJob?.cancel() }

    fun recoverAssets(uri: Uri) {
        scope.launch {
            mutableState.value = mutableState.value.copy(
                phase = SetupPhase.ASSETS,
                message = "Recovering Jun from your game ZIP…",
                error = null,
                recoveryProgress = TransferProgress(running = true),
            )
            try {
                recovery.recover(uri) { done, total, message ->
                    mutableState.value = mutableState.value.copy(
                        message = message,
                        recoveryProgress = TransferProgress(done, total, true),
                    )
                }
                refresh()
            } catch (error: Throwable) {
                Log.e(TAG, "Asset recovery failed", error)
                mutableState.value = mutableState.value.copy(
                    phase = SetupPhase.ERROR,
                    error = error.message ?: "Asset recovery failed",
                    recoveryProgress = mutableState.value.recoveryProgress.copy(running = false),
                )
            }
        }
    }

    fun downloadVoice() {
        if (voiceJob?.isActive == true) return
        voiceJob = scope.launch {
            mutableState.value = mutableState.value.copy(error = null, voiceProgress = TransferProgress(running = true))
            try {
                models.downloadVoice { bytes, total ->
                    mutableState.value = mutableState.value.copy(voiceProgress = TransferProgress(bytes, total, true))
                }
                refresh()
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(
                    phase = SetupPhase.ERROR,
                    error = error.message ?: "Voice download failed",
                    voiceProgress = mutableState.value.voiceProgress.copy(running = false),
                )
            }
        }
    }

    suspend fun startApp(server: LocalServer) {
        check(recovery.assetsReady())
        val choice = mutableState.value.mode
        val pairing = mutableState.value.pairing(choice)
        val engine = when {
            choice == SessionMode.LOCAL && models.modelReady() -> app.localEngine
            pairing != null -> RemoteEngine(pairing, pairings)
            else -> return
        }
        mutableState.value = mutableState.value.copy(
            phase = SetupPhase.STARTING,
            message = if (pairing != null) "Reaching ${pairing.name}…" else "Starting Jun OS…",
            pickError = null,
        )
        if (engine is RemoteEngine) {
            try {
                engine.ensureLoaded()
            } catch (error: Throwable) {
                Log.w(TAG, "remote engine unreachable", error)
                engine.close()
                mutableState.value = mutableState.value.copy(
                    phase = SetupPhase.PICK,
                    message = phaseMessage(SetupPhase.PICK),
                    pickError = explain(error, pairing!!),
                )
                return
            }
        }
        app.useEngine(engine)
        pairings.lastMode = choice
        val url = server.start()
        mutableState.value = mutableState.value.copy(ready = true, serverUrl = url)
    }

    // the colab page already saved it, no dialog: the user started that session from here
    suspend fun autoPair(pairing: Pairing, server: LocalServer) {
        mode = SessionMode.CLOUD
        val current = mutableState.value
        if (!current.ready) {
            if (current.phase != SetupPhase.PICK) return
            refresh()
            startApp(server)
            return
        }
        if (pairings.lastMode != SessionMode.CLOUD) return
        val engine = RemoteEngine(pairing, pairings)
        try {
            engine.ensureLoaded()
        } catch (error: Throwable) {
            Log.w(TAG, "new colab link unreachable", error)
            engine.close()
            return
        }
        app.useEngine(engine)
        mutableState.value = mutableState.value.copy(cloud = pairing)
    }

    fun close() { scope.cancel() }

    companion object {
        private const val TAG = "JunOS"
    }

    private fun phaseMessage(phase: SetupPhase) = when (phase) {
        SetupPhase.CHECKING -> "Checking this phone…"
        SetupPhase.CONSENT -> "Before Jun wakes up"
        SetupPhase.ASSETS -> "Jun's Live2D assets are not installed"
        SetupPhase.VOICE -> "Add offline voice"
        SetupPhase.PICK -> "Where does she think this time?"
        SetupPhase.STARTING -> "Starting Jun OS…"
        SetupPhase.ERROR -> "Setup needs attention"
    }

    private fun explain(error: Throwable, pairing: Pairing): String = when ((error as? RemoteError)?.code) {
        "lan_unreachable" -> "Can't reach ${pairing.name}. Is Jun OS running there, on the same wifi as this phone?"
        "cloud_unreachable" -> "Can't reach the notebook. Every run of Step 3 makes a new code, scan the new one."
        "unauthorized" -> "${pairing.name} doesn't know this phone anymore. Scan a fresh code."
        "lan_mode_off" -> "LAN mode is off on ${pairing.name}. Run ./start.sh phone there, or press Phone in the Jun OS app on Windows."
        "ca_changed" -> "${pairing.name} has a new certificate. Scan a fresh code."
        "certificate_mismatch" -> "${pairing.name}'s certificate doesn't cover this address. Scan a fresh code."
        else -> error.message ?: "Can't reach ${pairing.name}."
    }
}
