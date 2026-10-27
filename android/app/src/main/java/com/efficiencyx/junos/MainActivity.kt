package com.efficiencyx.junos

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.efficiencyx.junos.colab.ColabKeepAliveService
import com.efficiencyx.junos.colab.ColabSession
import com.efficiencyx.junos.colab.ColabState
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
        if (savedInstanceState == null) intent?.let(::handle)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        (application as JunApplication).colab.release(this)
        super.onDestroy()
    }

    private fun handle(intent: Intent) {
        if (intent.action == ColabKeepAliveService.ACTION_SHOW) (application as JunApplication).colab.show()
        else intent.dataString?.let(viewModel::offerPairing)
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
    val activity = LocalActivity.current
    val colab = (context.applicationContext as JunApplication).colab
    val colabState by colab.state.collectAsStateWithLifecycle()
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        // opaque and hit, so a hidden colab page under it neither shows nor gets taps
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).pointerInput(Unit) {}) {
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
                    colabRunning = colabState.running,
                    onColab = { if (colabState.running) colab.show() else activity?.let(colab::start) },
                    onColabInBrowser = { colab.openInBrowser(context) },
                    onStart = viewModel::startApp,
                    onRetry = viewModel::refresh,
                )
            }
        }
        if (colabState.running && activity != null) ColabLayer(colab, colabState, activity)
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

// hidden, not removed: a detached or paused page is a dead session to colab.
// NEVER resized either, 1dp <-> full screen froze the whole window. hiding = under her page
@Composable
private fun ColabLayer(session: ColabSession, state: ColabState, activity: Activity) {
    BackHandler(enabled = state.visible) { session.hide() }
    Column(
        Modifier.zIndex(if (state.visible) 1f else -1f).fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
            .then(if (state.visible) Modifier.imePadding() else Modifier),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                state.attention
                    ?: if (state.paired) "She's connected. Hide this, Colab keeps running."
                    else "Runtime > Run all. She connects by herself at Step 3.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = session::hide) { Text("Hide") }
            TextButton(onClick = session::stop) { Text("Stop") }
        }
        AndroidView(
            modifier = Modifier.fillMaxWidth().weight(1f),
            factory = { session.view(activity) ?: View(it) },
        )
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
    var pendingFiles by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        pendingFiles?.onReceiveValue(uri?.let { arrayOf(it) })
        pendingFiles = null
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                // fillMaxSize isn't enough. WRAP_CONTENT (the default) makes every vh/dvh 0 and the shop sheet vanishes
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
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
                    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                        pendingFiles?.onReceiveValue(null)
                        pendingFiles = callback
                        filePicker.launch(pickerMimeTypes(params.acceptTypes))
                        return true
                    }

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

// file managers hand out zips as octet-stream half the time
private fun pickerMimeTypes(accept: Array<String>): Array<String> {
    val types = accept.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.map { type ->
        if (type.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.drop(1)) ?: return arrayOf("*/*") else type
    }
    if (types.isEmpty()) return arrayOf("*/*")
    return (types + if ("application/zip" in types) listOf("application/x-zip-compressed", "application/octet-stream") else emptyList()).distinct().toTypedArray()
}
