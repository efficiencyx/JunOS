package com.efficiencyx.junos.colab

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.efficiencyx.junos.JunApplication
import com.efficiencyx.junos.MainActivity
import com.efficiencyx.junos.R

class ColabKeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        channels(this)
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, running(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JunOS:colab")
            .apply { acquire(MAX_SESSION_MS) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_SESSION -> (application as JunApplication).colab.stop()
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    private fun running() = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_launcher_foreground)
        .setContentTitle("Colab session running")
        .setContentText("Her brain stays up while this is here.")
        .setContentIntent(showIntent(this))
        .addAction(0, "Show", showIntent(this))
        .addAction(
            0, "Stop",
            PendingIntent.getService(
                this, 1, Intent(this, ColabKeepAliveService::class.java).setAction(ACTION_STOP_SESSION),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .setOngoing(true)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_SHOW = "com.efficiencyx.junos.SHOW_COLAB"
        private const val ACTION_STOP = "com.efficiencyx.junos.STOP_COLAB_SERVICE"
        private const val ACTION_STOP_SESSION = "com.efficiencyx.junos.STOP_COLAB"
        private const val CHANNEL = "colab"
        private const val ATTENTION_CHANNEL = "colab_attention"
        private const val NOTIFICATION_ID = 2002
        private const val ATTENTION_ID = 2003
        // free colab caps a session at 12 h anyway
        private const val MAX_SESSION_MS = 12L * 60 * 60 * 1000

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ColabKeepAliveService::class.java))
        }

        // same reason as GenerationService.stop(), never stopService()
        fun stop(context: Context) {
            NotificationManagerCompat.from(context).cancel(ATTENTION_ID)
            ContextCompat.startForegroundService(context, Intent(context, ColabKeepAliveService::class.java).setAction(ACTION_STOP))
        }

        fun attention(context: Context, text: String) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) return
            channels(context)
            val notification = NotificationCompat.Builder(context, ATTENTION_CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Colab needs you")
                .setContentText(text)
                .setContentIntent(showIntent(context))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build()
            NotificationManagerCompat.from(context).notify(ATTENTION_ID, notification)
        }

        private fun channels(context: Context) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
                NotificationChannel(CHANNEL, "Colab session", NotificationManager.IMPORTANCE_LOW),
                NotificationChannel(ATTENTION_CHANNEL, "Colab needs you", NotificationManager.IMPORTANCE_HIGH),
            ))
        }

        private fun showIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).setAction(ACTION_SHOW).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
