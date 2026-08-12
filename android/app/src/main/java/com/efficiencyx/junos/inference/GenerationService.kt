package com.efficiencyx.junos.inference

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.efficiencyx.junos.R

class GenerationService : Service() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Local generation", NotificationManager.IMPORTANCE_LOW),
        )
        enterForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        enterForeground()
        return START_NOT_STICKY
    }

    private fun enterForeground() {
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Jun is thinking")
            .setContentText("Generating locally on this phone")
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "generation"
        private const val NOTIFICATION_ID = 2001
    }
}
