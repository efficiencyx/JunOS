package com.efficiencyx.junos.setup

import android.content.Context
import android.net.Uri
import android.util.Log
import com.efficiencyx.junos.JunApplication
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
    private var modelJob: kotlinx.coroutines.Job? = null
    private var voiceJob: kotlinx.coroutines.Job? = null

    fun refresh() {
        val device = SystemCheck.inspect(app)
        val consented = prefs.getBoolean("adult_consent", false)
        val modelReady = models.modelReady()
        val assetsReady = recovery.assetsReady()
        val voiceReady = models.voiceReady()
        val phase = when {
            !device.supported -> SetupPhase.ERROR
            !consented -> SetupPhase.CONSENT
            !modelReady -> SetupPhase.MODEL
            !assetsReady -> SetupPhase.ASSETS
            !voiceReady -> SetupPhase.VOICE
            else -> SetupPhase.READY
        }
        mutableState.value = SetupState(
            phase = phase,
            device = device,
            consented = consented,
            modelReady = modelReady,
            assetsReady = assetsReady,
            voiceReady = voiceReady,
            message = phaseMessage(phase),
            error = if (!device.supported) unsupportedReason(device) else null,
        )
    }

    fun acceptConsent() {
        prefs.edit().putBoolean("adult_consent", true).putLong("adult_consent_at", System.currentTimeMillis()).apply()
        refresh()
    }

    fun downloadModel() {
        if (modelJob?.isActive == true) return
        modelJob = scope.launch {
            mutableState.value = mutableState.value.copy(
                phase = SetupPhase.MODEL,
                message = "Downloading Jun…",
                error = null,
                modelProgress = TransferProgress(running = true),
            )
            try {
                models.downloadModel { bytes, total ->
                    mutableState.value = mutableState.value.copy(modelProgress = TransferProgress(bytes, total, true))
                }
                refresh()
            } catch (_: CancellationException) {
                mutableState.value = mutableState.value.copy(
                    message = "Download paused. Your progress is saved.",
                    modelProgress = mutableState.value.modelProgress.copy(running = false),
                )
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(
                    phase = SetupPhase.ERROR,
                    error = error.message ?: "Model download failed",
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
        check(models.modelReady() && recovery.assetsReady())
        mutableState.value = mutableState.value.copy(phase = SetupPhase.STARTING, message = "Starting Jun OS…")
        val url = server.start()
        mutableState.value = mutableState.value.copy(ready = true, serverUrl = url)
    }

    fun close() { scope.cancel() }

    companion object {
        private const val TAG = "JunOS"
    }

    private fun phaseMessage(phase: SetupPhase) = when (phase) {
        SetupPhase.CHECKING -> "Checking this phone…"
        SetupPhase.CONSENT -> "Before Jun wakes up"
        SetupPhase.MODEL -> "Jun's local model is not installed"
        SetupPhase.ASSETS -> "Jun's Live2D assets are not installed"
        SetupPhase.VOICE -> "Add offline voice"
        SetupPhase.READY -> "Everything is ready"
        SetupPhase.STARTING -> "Starting Jun OS…"
        SetupPhase.ERROR -> "Setup needs attention"
    }

    private fun unsupportedReason(device: DeviceStatus): String = when {
        !device.supportedAbi -> "This build requires a 64-bit ARM phone."
        else -> "At least 5 GB of free storage is required during setup."
    }
}
