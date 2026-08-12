package com.efficiencyx.junos.setup

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.StatFs

object SystemCheck {
    fun inspect(context: Context): DeviceStatus {
        val memory = ActivityManager.MemoryInfo().also {
            context.getSystemService(ActivityManager::class.java).getMemoryInfo(it)
        }
        val stat = StatFs(context.filesDir.absolutePath)
        return DeviceStatus(
            supportedAbi = Build.SUPPORTED_64_BIT_ABIS.any { it == "arm64-v8a" },
            totalRamBytes = memory.totalMem,
            freeStorageBytes = stat.availableBytes,
        )
    }
}
