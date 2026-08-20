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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
fun SetupScreen(
    state: SetupState,
    onConsent: () -> Unit,
    onDownloadModel: () -> Unit,
    onPauseModel: () -> Unit,
    onSelectZip: () -> Unit,
    onDownloadVoice: () -> Unit,
    onContinue: () -> Unit,
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
                Text(
                    "This unofficial fan application contains mature material and AI-generated dialogue. " +
                        "Game artwork remains the property of its creator and is recovered only from your own copy.",
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(20.dp))
                Button(onClick = onConsent, modifier = Modifier.fillMaxWidth()) { Text("I am 18 or older") }
            }
            SetupPhase.MODEL -> {
                if (state.modelProgress.total > 0) {
                    LinearProgressIndicator(progress = { state.modelProgress.fraction }, modifier = Modifier.fillMaxWidth())
                    Text(formatProgress(state.modelProgress), style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(12.dp))
                }
                if (state.modelProgress.running) {
                    OutlinedButton(onClick = onPauseModel, modifier = Modifier.fillMaxWidth()) { Text("Pause download") }
                } else {
                    Button(onClick = onDownloadModel, modifier = Modifier.fillMaxWidth()) { Text("Download Jun model") }
                }
            }
            SetupPhase.ASSETS -> {
                Text(
                    "Download the official Windows or Linux game ZIP separately, then select that ZIP here. " +
                        "It is processed privately on this phone and is never uploaded.",
                    textAlign = TextAlign.Center,
                )
                if (state.recoveryProgress.running) {
                    Spacer(Modifier.height(16.dp))
                    LinearProgressIndicator(progress = { state.recoveryProgress.fraction }, modifier = Modifier.fillMaxWidth())
                } else {
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = onSelectZip, modifier = Modifier.fillMaxWidth()) { Text("Select game ZIP") }
                }
            }
            SetupPhase.VOICE -> {
                Text("Offline voice is optional and can be installed now or later.", textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                if (state.voiceProgress.running) {
                    LinearProgressIndicator(progress = { state.voiceProgress.fraction }, modifier = Modifier.fillMaxWidth())
                    Text(formatProgress(state.voiceProgress), style = MaterialTheme.typography.bodySmall)
                } else {
                    Button(onClick = onDownloadVoice, modifier = Modifier.fillMaxWidth()) { Text("Download offline voice") }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text("Continue without voice") }
            }
            SetupPhase.READY -> Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text("Open Jun OS") }
            SetupPhase.ERROR -> {
                Text(state.error ?: "Setup failed", color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
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
                    "Warning: less than 8 GB-class RAM may make responses slow or cause the model to stop.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Free storage", style = MaterialTheme.typography.bodySmall)
                Text(formatBytes(device.freeStorageBytes), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

private fun formatProgress(progress: TransferProgress) =
    if (progress.total > 0) "${formatBytes(progress.bytes)} / ${formatBytes(progress.total)}" else formatBytes(progress.bytes)

private fun formatBytes(value: Long): String {
    val gib = value.toDouble() / 1024 / 1024 / 1024
    return if (gib >= 1) "%.1f GB".format(gib) else "%.0f MB".format(value.toDouble() / 1024 / 1024)
}
