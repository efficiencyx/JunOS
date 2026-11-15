package com.efficiencyx.junos.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.efficiencyx.junos.R
import com.efficiencyx.junos.pairing.SessionMode

@Composable
fun SetupScreen(
    state: SetupState,
    onConsent: () -> Unit,
    onDownloadModel: () -> Unit,
    onPauseModel: () -> Unit,
    onSelectZip: () -> Unit,
    onDownloadVoice: () -> Unit,
    onSkipVoice: () -> Unit,
    onSelectMode: (SessionMode) -> Unit,
    onScan: () -> Unit,
    onPaste: () -> Unit,
    colabRunning: Boolean,
    onColab: () -> Unit,
    onColabInBrowser: () -> Unit,
    onSaveApiKey: (provider: String, key: String, model: String) -> Unit,
    onChatGptSignIn: (model: String) -> Unit,
    onForgetApi: () -> Unit,
    onStart: () -> Unit,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Ω", style = MaterialTheme.typography.displayLarge, color = MaterialTheme.colorScheme.primary)
        Text("Jun OS", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Text(state.message, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))

        when (state.phase) {
            SetupPhase.CHECKING, SetupPhase.STARTING -> CircularProgressIndicator()
            SetupPhase.CONSENT -> {
                Text(stringResource(R.string.setup_consent_body), textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Button(onClick = onConsent, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_consent_button)) }
            }
            SetupPhase.ASSETS -> {
                Text(stringResource(R.string.setup_assets_body), textAlign = TextAlign.Center)
                if (state.recoveryProgress.running) {
                    Spacer(Modifier.height(16.dp))
                    LinearProgressIndicator(progress = { state.recoveryProgress.fraction }, modifier = Modifier.fillMaxWidth())
                } else {
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = onSelectZip, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_select_zip)) }
                }
            }
            SetupPhase.VOICE -> {
                Text(stringResource(R.string.setup_voice_body), textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                if (state.voiceProgress.running) {
                    LinearProgressIndicator(progress = { state.voiceProgress.fraction }, modifier = Modifier.fillMaxWidth())
                    Text(formatProgress(state.voiceProgress), style = MaterialTheme.typography.bodySmall)
                } else {
                    Button(onClick = onDownloadVoice, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_download_voice)) }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onSkipVoice, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_skip_voice)) }
            }
            SetupPhase.PICK -> {
                ModeOption(
                    state, SessionMode.LOCAL, stringResource(R.string.setup_mode_local),
                    stringResource(if (state.modelReady) R.string.setup_mode_local_ready else R.string.setup_mode_local_needs_model),
                    onSelectMode,
                )
                ModeOption(
                    state, SessionMode.LAN, stringResource(R.string.setup_mode_lan),
                    state.lan?.let { stringResource(R.string.setup_mode_lan_paired, it.name) }
                        ?: stringResource(R.string.setup_mode_lan_detail),
                    onSelectMode,
                )
                ModeOption(
                    state, SessionMode.CLOUD, stringResource(R.string.setup_mode_cloud),
                    state.cloud?.let { stringResource(R.string.setup_mode_cloud_paired, it.name) }
                        ?: stringResource(R.string.setup_mode_cloud_detail),
                    onSelectMode,
                )
                ModeOption(
                    state, SessionMode.API, stringResource(R.string.setup_mode_api),
                    state.api?.let { stringResource(R.string.setup_mode_api_paired, it.name, it.model.orEmpty()) }
                        ?: stringResource(R.string.setup_mode_api_detail),
                    onSelectMode,
                )
                state.pickError?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                }
                Spacer(Modifier.height(20.dp))
                val paired = state.pairing(state.mode)
                when {
                    state.mode == SessionMode.LOCAL && !state.modelReady -> {
                        if (state.modelProgress.total > 0) {
                            LinearProgressIndicator(progress = { state.modelProgress.fraction }, modifier = Modifier.fillMaxWidth())
                            Text(formatProgress(state.modelProgress), style = MaterialTheme.typography.bodySmall)
                            Spacer(Modifier.height(12.dp))
                        }
                        if (state.modelProgress.running) {
                            OutlinedButton(onClick = onPauseModel, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_pause_download)) }
                        } else {
                            Button(onClick = onDownloadModel, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_download_model)) }
                        }
                    }
                    state.mode == SessionMode.API && paired == null -> ApiForm(state, onSaveApiKey, onChatGptSignIn)
                    state.mode == SessionMode.CLOUD && (paired == null || colabRunning) ->
                        Button(onClick = onColab, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(if (colabRunning) R.string.setup_back_to_colab else R.string.setup_start_colab))
                        }
                    state.mode != SessionMode.LOCAL && paired == null ->
                        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_scan_pairing)) }
                    else -> Button(onClick = onStart, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_start)) }
                }
                if (state.mode == SessionMode.CLOUD && paired != null && !colabRunning) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = onColab, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_new_colab)) }
                }
                if (state.mode == SessionMode.CLOUD && paired == null && !colabRunning) {
                    Text(
                        stringResource(R.string.setup_colab_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (state.mode == SessionMode.API && paired != null) {
                    TextButton(onClick = onForgetApi, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(if (paired.api == "chatgpt") R.string.setup_api_sign_out else R.string.setup_api_other))
                    }
                }
                if (state.mode == SessionMode.LAN || state.mode == SessionMode.CLOUD) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        if (paired != null || state.mode == SessionMode.CLOUD) TextButton(onClick = onScan) {
                            Text(stringResource(if (paired != null) R.string.setup_scan_new else R.string.setup_scan))
                        }
                        TextButton(onClick = onPaste) { Text(stringResource(R.string.setup_paste_link)) }
                    }
                }
                if (state.mode == SessionMode.CLOUD && !colabRunning) {
                    TextButton(onClick = onColabInBrowser, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.setup_colab_in_browser))
                    }
                }
            }
            SetupPhase.ERROR -> {
                Text(state.error ?: stringResource(R.string.setup_failed), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.setup_retry)) }
            }
        }

        state.device?.let { device ->
            Spacer(Modifier.height(24.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("RAM", style = MaterialTheme.typography.bodySmall)
                Text(formatBytes(device.totalRamBytes), style = MaterialTheme.typography.bodySmall)
            }
            if (!device.hasRequiredRam) {
                Text(
                    stringResource(R.string.setup_ram_warning),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(stringResource(R.string.setup_free_storage), style = MaterialTheme.typography.bodySmall)
                Text(formatBytes(device.freeStorageBytes), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

private val API_MODELS = mapOf(
    "openrouter" to "openrouter/auto",
    "openai-key" to "gpt-5-mini",
    "chatgpt" to "gpt-5.1",
)

@Composable
private fun ApiForm(
    state: SetupState,
    onSaveApiKey: (provider: String, key: String, model: String) -> Unit,
    onChatGptSignIn: (model: String) -> Unit,
) {
    var provider by rememberSaveable { mutableStateOf("openrouter") }
    var key by rememberSaveable { mutableStateOf("") }
    var model by rememberSaveable(provider) { mutableStateOf(API_MODELS.getValue(provider)) }
    val chatgpt = provider == "chatgpt"
    Column(Modifier.fillMaxWidth()) {
        ProviderOption(provider, "openrouter", "OpenRouter", stringResource(R.string.setup_api_openrouter_detail)) { provider = it }
        ProviderOption(provider, "openai-key", stringResource(R.string.setup_api_openai), stringResource(R.string.setup_api_openai_detail)) { provider = it }
        ProviderOption(provider, "chatgpt", stringResource(R.string.setup_api_chatgpt), stringResource(R.string.setup_api_chatgpt_detail)) { provider = it }
        Spacer(Modifier.height(8.dp))
        if (!chatgpt) {
            OutlinedTextField(
                value = key,
                onValueChange = { key = it },
                label = { Text(stringResource(R.string.setup_api_key)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OutlinedTextField(
            value = model,
            onValueChange = { model = it },
            label = { Text(stringResource(R.string.setup_api_model)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            stringResource(if (provider == "openrouter") R.string.setup_api_privacy_openrouter else R.string.setup_api_privacy_openai),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 8.dp),
        )
        Button(
            onClick = { if (chatgpt) onChatGptSignIn(model) else onSaveApiKey(provider, key, model) },
            enabled = !state.signingIn,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                stringResource(
                    when {
                        !chatgpt -> R.string.setup_api_save
                        state.signingIn -> R.string.setup_api_signing_in
                        else -> R.string.setup_api_sign_in
                    },
                ),
            )
        }
    }
}

@Composable
private fun ProviderOption(current: String, value: String, title: String, detail: String, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .selectable(selected = current == value, onClick = { onSelect(value) }, role = Role.RadioButton)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = current == value, onClick = null)
        Column(Modifier.padding(start = 12.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ModeOption(
    state: SetupState,
    mode: SessionMode,
    title: String,
    detail: String,
    onSelect: (SessionMode) -> Unit,
) {
    val selected = state.mode == mode
    Row(
        Modifier.fillMaxWidth()
            .selectable(selected = selected, onClick = { onSelect(mode) }, role = Role.RadioButton)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.padding(start = 12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun formatProgress(progress: TransferProgress) =
    if (progress.total > 0) "${formatBytes(progress.bytes)} / ${formatBytes(progress.total)}" else formatBytes(progress.bytes)

private fun formatBytes(value: Long): String {
    val gib = value.toDouble() / 1024 / 1024 / 1024
    return if (gib >= 1) "%.1f GB".format(gib) else "%.0f MB".format(value.toDouble() / 1024 / 1024)
}
