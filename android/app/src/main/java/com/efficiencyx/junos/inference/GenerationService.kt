package com.efficiencyx.junos.inference

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.efficiencyx.junos.R

class GenerationService : Service() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Generation", NotificationManager.IMPORTANCE_LOW),
        )
        enterForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        enterForeground(intent?.getStringExtra(EXTRA_WHERE))
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun enterForeground(where: String? = null) {
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Jun is thinking")
            .setContentText(if (where == null || where == "this phone") "Generating locally on this phone" else "Generating on $where")
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "generation"
        private const val NOTIFICATION_ID = 2001
        private const val ACTION_STOP = "com.efficiencyx.junos.STOP_GENERATION"
        private const val EXTRA_WHERE = "where"

        fun intent(context: Context, where: String): Intent =
            Intent(context, GenerationService::class.java).putExtra(EXTRA_WHERE, where)

        // NOT stopService(). a turn that fails fast would stop it before
        // startForeground() ran, and android kills the whole app for that
        fun stop(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, GenerationService::class.java).setAction(ACTION_STOP))
        }
    }
}
