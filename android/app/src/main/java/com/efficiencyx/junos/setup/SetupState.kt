package com.efficiencyx.junos.setup

data class DeviceStatus(
    val supportedAbi: Boolean,
    val totalRamBytes: Long,
    val freeStorageBytes: Long,
) {
    val hasRequiredRam: Boolean
        get() = totalRamBytes >= MIN_REPORTED_RAM

    val supported: Boolean
        get() = supportedAbi && freeStorageBytes >= MIN_FREE_STORAGE

    companion object {
        const val MIN_REPORTED_RAM = 7L * 1024 * 1024 * 1024
        const val MIN_FREE_STORAGE = 5L * 1024 * 1024 * 1024
    }
}

enum class SetupPhase { CHECKING, CONSENT, MODEL, ASSETS, VOICE, READY, STARTING, ERROR }

data class TransferProgress(
    val bytes: Long = 0,
    val total: Long = 0,
    val running: Boolean = false,
) {
    val fraction: Float get() = if (total > 0) (bytes.toDouble() / total).toFloat().coerceIn(0f, 1f) else 0f
}

data class SetupState(
    val phase: SetupPhase = SetupPhase.CHECKING,
    val device: DeviceStatus? = null,
    val consented: Boolean = false,
    val modelReady: Boolean = false,
    val assetsReady: Boolean = false,
    val voiceReady: Boolean = false,
    val modelProgress: TransferProgress = TransferProgress(),
    val recoveryProgress: TransferProgress = TransferProgress(),
    val voiceProgress: TransferProgress = TransferProgress(),
    val message: String = "Checking this phone…",
    val error: String? = null,
    val ready: Boolean = false,
    val serverUrl: String? = null,
)
