package com.efficiencyx.junos.setup

import android.content.Context
import android.net.Uri
import android.util.Log
import com.efficiencyx.junos.JunApplication
import com.efficiencyx.junos.R
import com.efficiencyx.junos.inference.RemoteEngine
import com.efficiencyx.junos.inference.RemoteError
import com.efficiencyx.junos.inference.RemoteWire
import com.efficiencyx.junos.pairing.ChatGptLogin
import com.efficiencyx.junos.pairing.SignInService
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
    private val mutableState = MutableStateFlow(SetupState(message = app.getString(R.string.setup_checking)))
    val state: StateFlow<SetupState> = mutableState.asStateFlow()
    private val pairings = app.pairingStore
    private var modelJob: kotlinx.coroutines.Job? = null
    private var voiceJob: kotlinx.coroutines.Job? = null
    private var signInJob: kotlinx.coroutines.Job? = null
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
            error = if (!device.supported) app.getString(R.string.setup_needs_arm64) else null,
            mode = mode,
            lan = pairings.get(SessionMode.LAN),
            cloud = pairings.get(SessionMode.CLOUD),
            api = pairings.get(SessionMode.API),
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
            mutableState.value.copy(pickError = app.getString(R.string.err_not_pairing_code))
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

    fun saveApiKey(provider: String, key: String, model: String) {
        val token = key.trim()
        val name = model.trim()
        if (token.isEmpty() || name.isEmpty()) {
            mutableState.value = mutableState.value.copy(pickError = app.getString(R.string.err_api_missing))
            return
        }
        val openRouter = provider == "openrouter"
        pairings.save(
            Pairing(
                mode = SessionMode.API,
                name = if (openRouter) "OpenRouter" else "OpenAI",
                urls = listOf(if (openRouter) RemoteWire.OPENROUTER else RemoteWire.OPENAI),
                token = token,
                api = if (openRouter) "openrouter" else "openai-key",
                model = name,
                ctx = API_CONTEXT,
            ),
        )
        mode = SessionMode.API
        refresh()
    }

    fun signInChatGpt(model: String, openBrowser: (String) -> Unit) {
        val name = model.trim()
        if (name.isEmpty()) {
            mutableState.value = mutableState.value.copy(pickError = app.getString(R.string.err_model_name))
            return
        }
        val previous = signInJob?.also { it.cancel() }
        val session = ChatGptLogin.begin()
        mutableState.value = mutableState.value.copy(signingIn = true, pickError = null)
        signInJob = scope.launch {
            // the old one's finally stops the service and frees :1455, let it finish first
            previous?.join()
            SignInService.start(app)
            try {
                val code = ChatGptLogin.awaitCode(session, app.getString(R.string.pair_chatgpt_failed_page))
                pairings.save(ChatGptLogin.exchange(session, code, name).copy(ctx = API_CONTEXT))
                mode = SessionMode.API
                refresh()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                Log.w(TAG, "chatgpt sign-in failed", error)
                mutableState.value = mutableState.value.copy(signingIn = false, pickError = explainSignIn(error))
            } finally {
                SignInService.stop(app)
            }
        }
        openBrowser(session.authorizeUrl)
    }

    fun forgetApi() {
        signInJob?.cancel()
        pairings.remove(SessionMode.API)
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
            mutableState.value = mutableState.value.copy(pickError = app.getString(R.string.err_model_storage))
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
                    pickError = app.getString(R.string.setup_download_paused),
                    modelProgress = mutableState.value.modelProgress.copy(running = false),
                )
            } catch (error: Throwable) {
                mutableState.value = mutableState.value.copy(
                    pickError = error.message ?: app.getString(R.string.err_model_download),
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
                message = app.getString(R.string.setup_recovering),
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
                    error = error.message ?: app.getString(R.string.err_recovery),
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
                    error = error.message ?: app.getString(R.string.err_voice_download),
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
            message = if (pairing != null) app.getString(R.string.pair_reaching, pairing.name) else app.getString(R.string.setup_starting),
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
        // every turn sends (and bills) the whole history again
        private const val API_CONTEXT = 32768
    }

    private fun phaseMessage(phase: SetupPhase) = app.getString(
        when (phase) {
            SetupPhase.CHECKING -> R.string.setup_checking
            SetupPhase.CONSENT -> R.string.setup_consent_title
            SetupPhase.ASSETS -> R.string.setup_assets_title
            SetupPhase.VOICE -> R.string.setup_voice_title
            SetupPhase.PICK -> R.string.setup_pick_title
            SetupPhase.STARTING -> R.string.setup_starting
            SetupPhase.ERROR -> R.string.setup_error_title
        },
    )

    private fun explainSignIn(error: Throwable): String = app.getString(
        when ((error as? RemoteError)?.code) {
            "chatgpt_port_busy" -> R.string.err_chatgpt_port_busy
            "chatgpt_cancelled" -> R.string.err_chatgpt_cancelled
            "unauthorized" -> R.string.err_chatgpt_refused
            else -> R.string.err_chatgpt_unreachable
        },
    )

    private fun explain(error: Throwable, pairing: Pairing): String {
        val code = (error as? RemoteError)?.code
        if (code == "unauthorized" && pairing.mode == SessionMode.API) {
            return if (pairing.api == "chatgpt") app.getString(R.string.err_chatgpt_signed_out) else app.getString(R.string.err_key_refused, pairing.name)
        }
        return explainCode(code, error, pairing)
    }

    private fun explainCode(code: String?, error: Throwable, pairing: Pairing): String {
        val text = when (code) {
            "api_unreachable" -> R.string.err_api_unreachable
            "no_credit" -> R.string.err_no_credit
            "rate_limited" -> R.string.err_rate_limited
            "lan_unreachable" -> R.string.err_lan_unreachable
            "cloud_unreachable" -> R.string.err_cloud_unreachable
            "unauthorized" -> R.string.err_unauthorized
            "lan_mode_off" -> R.string.err_lan_mode_off
            "ca_changed" -> R.string.err_ca_changed
            "certificate_mismatch" -> R.string.err_certificate_mismatch
            else -> return error.message ?: app.getString(R.string.err_unreachable, pairing.name)
        }
        return app.getString(text, pairing.name)
    }
}
