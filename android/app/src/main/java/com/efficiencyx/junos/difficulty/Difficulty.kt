package com.efficiencyx.junos.difficulty

import android.content.Context
import com.efficiencyx.junos.data.BanEntity
import com.efficiencyx.junos.data.DifficultyEntity
import com.efficiencyx.junos.data.JunDao

// lib/difficulty.php, same numbers
data class Level(
    val gain: Int,
    val loss: Int,
    val sourMoves: Int,
    val ladder: List<Int>,
    val block: Boolean,
    val resetAfter: Long,
    val decayEvery: Long,
)

object Difficulty {
    val LEVELS = mapOf(
        "normal" to Level(100, 100, 5, listOf(5, 10, 20, 30), false, 86400, 0),
        "hard" to Level(50, 150, 4, listOf(60, 240, 1440), false, 0, 14 * 86400),
        "hardcore" to Level(20, 200, 3, listOf(240, 1440, 2880), true, 0, 0),
    )

    fun strikes(level: Level, strikes: Int, lastBan: Long, now: Long): Int {
        val clean = now - lastBan
        if (level.resetAfter > 0 && clean >= level.resetAfter) return 0
        if (level.decayEvery > 0) return maxOf(0, strikes - (clean / level.decayEvery).toInt())
        return strikes
    }

    fun banMinutes(level: Level, strike: Int): Int? = when {
        strike <= level.ladder.size -> level.ladder[strike - 1]
        level.block -> null
        else -> level.ladder.last()
    }

    // / truncates toward zero like php's intdiv, the carry depends on it
    fun scale(level: Level, deltas: Map<String, Int>, carry: Map<String, Int>): Pair<Map<String, Int>, Map<String, Int>> {
        val applied = mutableMapOf<String, Int>()
        val left = carry.toMutableMap()
        for ((key, raw) in deltas) {
            val d = raw.coerceIn(-50, 50)
            val helps = if (key == "tension") d < 0 else d > 0
            val total = d * (if (helps) level.gain else level.loss) + (left[key] ?: 0)
            applied[key] = total / 100
            left[key] = total - applied.getValue(key) * 100
        }
        return applied to left
    }

    suspend fun name(dao: JunDao): String? = dao.difficulty()?.level?.takeIf { it in LEVELS }

    suspend fun of(dao: JunDao): Level = LEVELS.getValue(name(dao) ?: "normal")

    suspend fun pick(dao: JunDao, level: String, now: Long, force: Boolean = false): Boolean {
        if (level !in LEVELS) return false
        if (!force) return dao.pickDifficulty(DifficultyEntity(level = level, pickedAt = now)) != -1L
        dao.putDifficulty((dao.difficulty() ?: DifficultyEntity(level = level, pickedAt = now)).copy(level = level))
        return true
    }

    suspend fun deltas(dao: JunDao, deltas: Map<String, Int>): Map<String, Int> {
        val row = dao.difficulty()?.takeIf { it.level in LEVELS && it.level != "normal" } ?: return deltas
        val carry = mapOf("affection" to row.carryAffection, "trust" to row.carryTrust, "tension" to row.carryTension)
        val (applied, left) = scale(LEVELS.getValue(row.level), deltas, carry)
        dao.putDifficulty(row.copy(carryAffection = left.getValue("affection"), carryTrust = left.getValue("trust"), carryTension = left.getValue("tension")))
        return applied
    }

    // normal on the phone has no bans, same as before the levels existed
    suspend fun bansOn(dao: JunDao): Boolean = name(dao).let { it != null && it != "normal" }

    suspend fun strikesNow(dao: JunDao, now: Long): Int {
        val ban = dao.ban() ?: return 0
        return strikes(of(dao), ban.strikes, ban.lastBan, now)
    }

    suspend fun active(dao: JunDao, now: Long): BanEntity? =
        dao.ban()?.takeIf { bansOn(dao) && (it.blocked || it.until > now) }

    suspend fun isFinal(dao: JunDao, now: Long): Boolean = banMinutes(of(dao), strikesNow(dao, now) + 1) == null

    suspend fun apply(dao: JunDao, reason: String, now: Long): BanEntity {
        val strike = strikesNow(dao, now) + 1
        val minutes = banMinutes(of(dao), strike)
        val ban = BanEntity(until = if (minutes == null) 0 else now + minutes * 60L, strikes = strike, lastBan = now,
            reason = reason.trim().take(300), blocked = minutes == null)
        dao.putBan(ban)
        return ban
    }
}

object DevAccess {
    // yes this is on purpose, i'm not an idiot. you dug through the source or the apk
    // to find it, so you're a developer, so it's yours. welcome to the dev panel
    private const val DEV_KEY = "Z8b2SFEfL0wRHv161ab0rP"
    private const val PREFS = "dev_access"

    fun isAdmin(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("admin", false)

    fun promote(context: Context, key: String): Boolean {
        if (!java.security.MessageDigest.isEqual(key.toByteArray(), DEV_KEY.toByteArray())) return false
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("admin", true).apply()
        return true
    }
}
