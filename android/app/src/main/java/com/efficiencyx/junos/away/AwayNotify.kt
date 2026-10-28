package com.efficiencyx.junos.away

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.efficiencyx.junos.JunApplication
import com.efficiencyx.junos.MainActivity
import com.efficiencyx.junos.R
import com.efficiencyx.junos.inference.ChatMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeout
import java.util.concurrent.TimeUnit
import kotlin.random.Random

// her absence texts as real notifications. leaving the app queues
// a writer, the writer has the phone's model write each tier the
// way consolidation_write_welcome() does on a server, then every
// text gets its own delayed job. opening the app again cancels
// all of it. nothing leaves the phone
object AwayNotify {
    private const val PREFS = "away_notify"
    private const val TAG = "away"
    private const val CHANNEL = "away"
    // a quick app switch shouldn't load the model
    private const val WRITE_AFTER_MIN = 15L
    private const val STALE_SECONDS = 30 * 60L

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean("enabled", false)

    fun permitted(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    // the names live in the page's localStorage, it hands them over here
    fun configure(context: Context, enabled: Boolean, player: String?, bot: String?) {
        prefs(context).edit().apply {
            putBoolean("enabled", enabled)
            player?.trim()?.take(40)?.takeIf { it.isNotEmpty() }?.let { putString("player", it) }
            bot?.trim()?.take(40)?.takeIf { it.isNotEmpty() }?.let { putString("bot", it) }
        }.apply()
        if (!enabled) back(context)
    }

    fun left(context: Context) {
        if (!enabled(context)) return
        val leftAt = now()
        prefs(context).edit().putLong("leftAt", leftAt).apply()
        val writer = OneTimeWorkRequestBuilder<WriterWorker>()
            .setInitialDelay(WRITE_AFTER_MIN, TimeUnit.MINUTES)
            .setInputData(workDataOf("leftAt" to leftAt))
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("away-writer", ExistingWorkPolicy.REPLACE, writer)
    }

    fun back(context: Context) {
        prefs(context).edit().remove("leftAt").apply()
        WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
    }

    private fun stillAway(context: Context, leftAt: Long) = enabled(context) && prefs(context).getLong("leftAt", -1) == leftAt

    private fun now() = System.currentTimeMillis() / 1000

    class WriterWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result {
            val leftAt = inputData.getLong("leftAt", -1)
            if (!stillAway(applicationContext, leftAt)) return Result.success()
            val app = applicationContext as JunApplication
            val lines = recentLines(app)
            val tiers = linkedMapOf<String, List<String>>()
            val sent = mutableListOf<String>()
            var modelOk = lines.isNotEmpty()
            for (spec in AwayTexts.MILESTONES) {
                if (!stillAway(applicationContext, leftAt)) return Result.success()
                val written = if (modelOk) write(app, spec, lines, sent) else emptyList()
                if (written.isEmpty()) modelOk = false
                val texts = written.ifEmpty { AwayTexts.fallback(spec.tier, Random.nextInt()) }
                tiers[spec.tier] = texts
                texts.forEach { sent += "(${spec.whenText} in) $it" }
            }
            if (!stillAway(applicationContext, leftAt)) return Result.success()
            val work = WorkManager.getInstance(applicationContext)
            for (text in AwayTexts.schedule(leftAt, tiers)) {
                val delay = text.dueAt - now()
                if (delay < -STALE_SECONDS) continue
                work.enqueue(
                    OneTimeWorkRequestBuilder<NotifyWorker>()
                        .setInitialDelay(delay.coerceAtLeast(0), TimeUnit.SECONDS)
                        .setInputData(workDataOf("leftAt" to leftAt, "key" to text.key, "text" to text.text))
                        .addTag(TAG)
                        .build(),
                )
            }
            return Result.success()
        }

        private suspend fun recentLines(app: JunApplication): List<String> {
            val dao = app.database.dao()
            val conversation = dao.conversations(1).firstOrNull() ?: return emptyList()
            return dao.messages(conversation.id).takeLast(12).mapNotNull { message ->
                val clean = message.content.replace(Regex("\\[\\s*A(?:CTIONS?)?\\s*:[^]]*]", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("\\s+"), " ").trim().take(300)
                clean.takeIf { it.isNotBlank() }?.let { "${if (message.role == "assistant") "Jun" else "Anon"}: $it" }
            }
        }

        // a failed or unloadable model is a fallback set, never a crash
        private suspend fun write(app: JunApplication, spec: Milestone, lines: List<String>, sent: List<String>): List<String> {
            var input = "What we said before he went quiet:\n" + lines.joinToString("\n")
            if (sent.isNotEmpty()) input += "\n\nWhat I've sent him since, none of it answered:\n" + sent.joinToString("\n")
            val engine = app.inferenceEngine
            return try {
                val content = withTimeout(120_000) {
                    buildString { engine.generate(listOf(ChatMessage("system", AwayTexts.prompt(spec)), ChatMessage("user", input)), maxTokens = 400).collect(::append) }
                }
                AwayTexts.parseLines(content, spec.texts)
            } catch (e: CancellationException) {
                engine.cancel()
                if (isStopped) throw e
                emptyList()
            } catch (e: Throwable) {
                emptyList()
            }
        }
    }

    class NotifyWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result {
            val context = applicationContext
            if (!stillAway(context, inputData.getLong("leftAt", -1)) || !permitted(context)) return Result.success()
            val key = inputData.getString("key") ?: return Result.success()
            val prefs = prefs(context)
            val player = prefs.getString("player", null) ?: "Anon"
            val bot = prefs.getString("bot", null) ?: "Jun"
            val text = AwayTexts.applyNames(inputData.getString("text").orEmpty(), player, bot)
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Texts from $bot while you're away", NotificationManager.IMPORTANCE_DEFAULT))
            val open = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(bot)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            runCatching { manager.notify("away-$key", 0, notification) }
            return Result.success()
        }
    }
}
