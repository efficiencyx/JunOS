package com.efficiencyx.junos

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.efficiencyx.junos.setup.SetupCoordinator
import com.efficiencyx.junos.setup.SetupState
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as JunApplication
    private val coordinator = SetupCoordinator(app, app.modelStore, app.assetRecovery)
    val state: StateFlow<SetupState> = coordinator.state

    init { refresh() }

    fun refresh() = coordinator.refresh()
    fun acceptConsent() = coordinator.acceptConsent()
    fun downloadModel() = coordinator.downloadModel()
    fun pauseModelDownload() = coordinator.pauseModelDownload()
    fun downloadVoice() = coordinator.downloadVoice()
    fun recoverAssets(uri: Uri) = coordinator.recoverAssets(uri)

    fun startApp() {
        viewModelScope.launch {
            coordinator.startApp(app.localServer)
        }
    }

    override fun onCleared() {
        coordinator.close()
        super.onCleared()
    }
}
