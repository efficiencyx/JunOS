package com.efficiencyx.junos

import android.Manifest
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.efficiencyx.junos.pairing.SessionMode
import com.efficiencyx.junos.setup.SetupScreen
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(background = Color(0xFF131314))) {
                JunRoot(viewModel)
            }
        }
        if (savedInstanceState == null) intent?.dataString?.let(viewModel::offerPairing)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let(viewModel::offerPairing)
    }
}

@Composable
private fun JunRoot(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val zipPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) viewModel.recoverAssets(uri)
    }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(viewModel::offerPairing)
    }
    val context = LocalContext.current
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (state.ready && state.serverUrl != null) {
            JunWebView(state.serverUrl!!)
        } else {
            SetupScreen(
                state = state,
                onConsent = viewModel::acceptConsent,
                onDownloadModel = viewModel::downloadModel,
                onPauseModel = viewModel::pauseModelDownload,
                onSelectZip = { zipPicker.launch(arrayOf("application/zip", "application/octet-stream")) },
                onDownloadVoice = viewModel::downloadVoice,
                onSkipVoice = viewModel::skipVoice,
                onSelectMode = viewModel::select,
                onScan = {
                    scanner.launch(
                        ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false)
                            .setOrientationLocked(false).setPrompt("The code from your PC or the notebook"),
                    )
                },
                onPaste = {
                    val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
                    viewModel.offerPairing(clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty())
                },
                onStart = viewModel::startApp,
                onRetry = viewModel::refresh,
            )
        }
        state.offer?.let { offer ->
            AlertDialog(
                onDismissRequest = viewModel::dismissOffer,
                title = { Text("Pair with ${offer.name}?") },
                text = {
                    Text(buildString {
                        append(
                            if (offer.mode == SessionMode.LAN) "LAN, at ${offer.host}."
                            else "Cloud, through ${offer.host}. Chats pass through Google and Cloudflare.",
                        )
                        state.pairing(offer.mode)?.let { append(" Replaces ${it.name}.") }
                        if (state.ready) append(" Used from the next launch.")
                    })
                },
                confirmButton = { TextButton(onClick = viewModel::acceptOffer) { Text("Pair") } },
                dismissButton = { TextButton(onClick = viewModel::dismissOffer) { Text("Cancel") } },
            )
        }
    }
}

@Composable
private fun JunWebView(url: String) {
    var pendingAudioRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    val audioPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pendingAudioRequest?.let { request ->
            if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
        }
        pendingAudioRequest = null
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.allowFileAccessFromFileURLs = false
                settings.allowUniversalAccessFromFileURLs = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.mediaPlaybackRequiresUserGesture = false
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val target = request.url
                        val local = target.scheme == "http" && target.host == "127.0.0.1" &&
                            target.port == Uri.parse(url).port
                        if (!local) context.startActivity(Intent(Intent.ACTION_VIEW, target))
                        return !local
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) {
                        val audioOnly = request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        if (!audioOnly) return request.deny()
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.resources)
                        } else {
                            pendingAudioRequest = request
                            audioPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }
                }
                loadUrl(url)
            }
        },
    )
}
