package com.efficiencyx.junos.colab

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.net.toUri
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.efficiencyx.junos.JunApplication
import com.efficiencyx.junos.pairing.Pairing
import com.efficiencyx.junos.pairing.SessionMode
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ColabState(
    val running: Boolean = false,
    val visible: Boolean = false,
    val paired: Boolean = false,
    val attention: String? = null,
)

class ColabSession(private val app: JunApplication) {
    private val mutableState = MutableStateFlow(ColabState())
    val state: StateFlow<ColabState> = mutableState.asStateFlow()
    private val mutablePairings = MutableSharedFlow<Pairing>(extraBufferCapacity = 1)
    val pairings: SharedFlow<Pairing> = mutablePairings
    private val host = MutableContextWrapper(app)
    private var webView: WebView? = null

    fun start(activity: Activity) {
        host.baseContext = activity
        if (webView == null) {
            webView = build().apply { loadUrl(NOTEBOOK) }
            mutableState.value = ColabState(running = true)
            ColabKeepAliveService.start(app)
        }
        show()
    }

    fun view(activity: Activity): WebView? {
        host.baseContext = activity
        return webView?.also { (it.parent as? ViewGroup)?.removeView(it) }
    }

    // dialogs and the keyboard need an activity, the page itself doesn't
    fun release(activity: Activity) {
        if (host.baseContext === activity) host.baseContext = app
    }

    fun show() {
        if (webView != null) mutableState.value = mutableState.value.copy(visible = true, attention = null)
    }

    fun hide() {
        mutableState.value = mutableState.value.copy(visible = false)
    }

    fun stop() {
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        mutableState.value = ColabState()
        ColabKeepAliveService.stop(app)
    }

    fun openInBrowser(context: Context) {
        context.startActivity(Intent(Intent.ACTION_VIEW, NOTEBOOK.toUri()))
    }

    private fun onMessage(data: String) {
        when (data) {
            "still_there" -> attention("Colab wants to know you're still there.")
            "disconnected" -> attention("Colab dropped the runtime. Run Step 3 again, or stop the session.")
            else -> {
                val pairing = Pairing.parse(data)?.takeIf { it.mode == SessionMode.CLOUD } ?: return
                app.pairingStore.save(pairing)
                mutableState.value = mutableState.value.copy(paired = true, visible = false, attention = null)
                mutablePairings.tryEmit(pairing)
            }
        }
    }

    private fun attention(text: String) {
        if (mutableState.value.attention == text) return
        mutableState.value = mutableState.value.copy(attention = text)
        ColabKeepAliveService.attention(app, text)
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun build(): WebView = WebView(host).apply {
        // AndroidView's default WRAP_CONTENT makes every vh 0, same as the main webview
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.setSupportMultipleWindows(false)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        // google's sign-in page refuses anything it can tell is a webview: "; wv" and
        // Version/4.0 in the UA, and the X-Requested-With header carrying our package name
        settings.userAgentString = settings.userAgentString.replace("; wv", "").replace("Version/4.0 ", "")
        runCatching { WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet()) }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host.orEmpty()
                val inside = request.url.scheme == "https" &&
                    (GOOGLE_HOSTS.any { host == it || host.endsWith(".$it") } || COUNTRY_GOOGLE.matches(host))
                if (!inside) {
                    Log.i(TAG, "sent to the browser: $host")
                    runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return !inside
            }

            // returning false here kills the whole app along with the page
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                stop()
                ColabKeepAliveService.attention(app, "The Colab page crashed. Start a new session, Colab picks the same runtime back up.")
                return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, "junos", BRIDGE_ORIGINS) { _, message, _, _, _ ->
                message.data?.let(::onMessage)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(this, WATCHER, setOf(COLAB_ORIGIN))
        }
    }

    companion object {
        const val NOTEBOOK = "https://colab.research.google.com/github/efficiencyx/JunOS/blob/main/colab.ipynb"
        private const val COLAB_ORIGIN = "https://colab.research.google.com"
        // the notebook's outputs render in iframes on *.googleusercontent.com,
        // that's where Step 1 looks for window.junos and Step 3 posts the link
        private val BRIDGE_ORIGINS = setOf(COLAB_ORIGIN, "https://*.googleusercontent.com")
        // sign-in ends with a hop through accounts.youtube.com (and sometimes google.<country>)
        // to set the cookies there. send that out and the YouTube app eats the login
        private val GOOGLE_HOSTS = listOf("google.com", "googleusercontent.com", "gstatic.com", "youtube.com")
        private val COUNTRY_GOOGLE = Regex("""(.+\.)?google\.(com?\.)?[a-z]{2}""")
        private const val TAG = "ColabSession"

        // best effort. colab's dialogs have no stable ids, so it reads their text
        private val WATCHER = """
            (function () {
              if (window.top !== window) return;
              var last = '';
              setInterval(function () {
                var text = document.body ? document.body.innerText : '';
                var now = /are you still there/i.test(text) ? 'still_there'
                  : /runtime disconnected/i.test(text) ? 'disconnected' : '';
                if (now && now !== last && window.junos) window.junos.postMessage(now);
                last = now;
              }, 15000);
            })();
        """.trimIndent()
    }
}
