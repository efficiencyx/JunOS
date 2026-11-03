package com.efficiencyx.junos.pairing

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.efficiencyx.junos.R

// chrome on top = android FREEZES us, and the :1455 callback sits unanswered until you come back
class SignInService : Service() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Sign-in", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Signing in to ChatGPT")
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "signin"
        private const val NOTIFICATION_ID = 2004
        private const val ACTION_STOP = "com.efficiencyx.junos.STOP_SIGNIN"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, SignInService::class.java))
        }

        // same trap as GenerationService.stop(). from the background android can refuse
        // that start, and by then startForeground() ran long ago so stopService is safe
        fun stop(context: Context) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, SignInService::class.java).setAction(ACTION_STOP))
            }.onFailure { context.stopService(Intent(context, SignInService::class.java)) }
        }
    }
}
