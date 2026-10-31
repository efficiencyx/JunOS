package com.efficiencyx.junos.achievements

import android.content.Context
import android.util.Log
import com.efficiencyx.junos.data.AchievementSeenEntity
import com.efficiencyx.junos.data.AchievementStatEntity
import com.efficiencyx.junos.data.JunDatabase
import com.efficiencyx.junos.data.RelationshipEntity
import com.efficiencyx.junos.wardrobe.WardrobeState
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.LocalTime

@Serializable
data class AchievementDef(
    val id: String,
    val group: String,
    val stat: String,
    val name: String,
    val desc: String,
    val tiers: List<Long>,
    val hidden: Boolean = false,
    val low: Boolean = false,
)

// port of webapp/api/lib/achievements.php, catalog shared through
// achievements.json. every counter swallows its own errors, a broken
// one must NEVER cost Anon a reply
class Achievements(private val context: Context, private val database: JunDatabase) {
    private val dao get() = database.dao()
    private val mutex = Mutex()

    val catalog: List<AchievementDef> by lazy {
        val all = context.assets.open("data/achievements.json").bufferedReader().use {
            Json { ignoreUnknownKeys = true }.decodeFromString<List<AchievementDef>>(it.readText())
        }
        all.filter { it.stat !in PHONE_CANT }
    }

    suspend fun add(stat: String, by: Long = 1) {
        if (by > 0) update(stat) { (it ?: 0) + by }
    }

    suspend fun max(stat: String, value: Long) = update(stat) { maxOf(it ?: value, value) }

    suspend fun min(stat: String, value: Long) = update(stat) { minOf(it ?: value, value) }

    private suspend fun update(stat: String, merge: (Long?) -> Long) {
        runCatching { mutex.withLock { put(stat, merge(dao.achievementStat(stat)?.value)) } }
            .onFailure { Log.w(TAG, "achievement $stat failed", it) }
    }

    private suspend fun put(stat: String, value: Long) =
        dao.putAchievementStat(AchievementStatEntity(stat, value, System.currentTimeMillis() / 1000))

    suspend fun onUserMessage(text: String, voice: Boolean) {
        add("messages")
        touchDay(LocalDate.now().toEpochDay())
        if (LocalTime.now().hour in 2..4) add("night")
        if (voice) {
            add("voice")
            return
        }
        val trimmed = text.trim()
        val len = trimmed.codePointCount(0, trimmed.length).toLong()
        max("longest", len)
        if (len in 1..3) add("short")
    }

    private suspend fun touchDay(day: Long) {
        runCatching {
            mutex.withLock {
                val last = dao.achievementStat("day_last")?.value
                // a day that went BACKWARDS is a timezone hop, not a new day
                if (last != null && last >= day) return@withLock
                put("day_last", day)
                put("days", (dao.achievementStat("days")?.value ?: 0) + 1)
                val streak = if (last == day - 1) (dao.achievementStat("streak_cur")?.value ?: 0) + 1 else 1
                put("streak_cur", streak)
                put("streak", maxOf(streak, dao.achievementStat("streak")?.value ?: 0))
            }
        }.onFailure { Log.w(TAG, "achievement day_last failed", it) }
    }

    suspend fun onRelationship(before: RelationshipEntity, after: RelationshipEntity) {
        max("affection_peak", after.affection.toLong())
        max("trust_peak", after.trust.toLong())
        max("tension_peak", after.tension.toLong())
        min("tension_low", after.tension.toLong())
        add("gauge_moved", (Math.abs(after.affection - before.affection) + Math.abs(after.trust - before.trust) +
            Math.abs(after.tension - before.tension)).toLong())
    }

    fun wornChanged(before: WardrobeState?, after: WardrobeState?): Boolean =
        before != null && after != null && (before.items != after.items || before.variants != after.variants)

    fun tier(a: AchievementDef, value: Long?): Int {
        if (value == null) return 0
        var tier = 0
        a.tiers.forEachIndexed { i, need -> if (if (a.low) value <= need else value >= need) tier = i + 1 }
        return tier
    }

    // the phone's one account is the admin, so it always sees through the ???
    suspend fun list(): JsonObject {
        val stats = dao.achievementStats().associate { it.stat to it.value }
        val seen = dao.achievementSeen().associate { it.ach to it.tier }
        val fresh = mutableListOf<JsonObject>()
        val list = buildJsonArray {
            for (a in catalog) {
                val value = stats[a.stat]
                val tier = tier(a, value)
                add(buildJsonObject {
                    put("id", a.id); put("group", a.group); put("name", a.name); put("desc", a.desc)
                    put("secret", a.hidden && tier == 0); put("low", a.low)
                    put("tiers", JsonArray(a.tiers.map { JsonPrimitive(it) }))
                    put("value", value?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("tier", tier)
                })
                if (tier > (seen[a.id] ?: 0)) fresh += buildJsonObject { put("id", a.id); put("name", a.name); put("tier", tier) }
            }
        }
        return buildJsonObject {
            put("tier_names", JsonArray(TIERS.map { JsonPrimitive(it) }))
            put("list", list)
            put("fresh", JsonArray(fresh))
            put("dev", true)
        }
    }

    suspend fun markSeen(items: JsonArray) {
        val known = catalog.associateBy { it.id }
        val seen = dao.achievementSeen().associate { it.ach to it.tier }
        for (item in items.take(known.size)) {
            val obj = item as? JsonObject ?: continue
            val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: continue
            if (id !in known) continue
            val tier = (obj["tier"]?.jsonPrimitive?.intOrNull ?: 0).coerceIn(0, TIERS.size)
            dao.putAchievementSeen(AchievementSeenEntity(id, maxOf(tier, seen[id] ?: 0)))
        }
    }

    // dev override. null wipes the counter, seen drops with the value
    // so pushing it back up toasts the tier again
    suspend fun set(id: String, value: Long?): Boolean {
        val a = catalog.firstOrNull { it.id == id } ?: return false
        mutex.withLock {
            if (value == null) dao.deleteAchievementStat(a.stat) else put(a.stat, maxOf(0, value))
        }
        val cap = tier(a, value?.let { maxOf(0, it) })
        val seen = dao.achievementSeen().firstOrNull { it.ach == id }
        if (seen != null && seen.tier > cap) dao.putAchievementSeen(seen.copy(tier = cap))
        return true
    }

    companion object {
        private const val TAG = "Achievements"
        private val TIERS = listOf("bronze", "silver", "gold", "diamond")

        // the only stats the browser may bump, same as ACH_CLIENT_STATS
        val CLIENT_STATS = setOf("bj_won", "bj_lost", "bj_natural", "bj_bust")

        // no karaoke, no web search, no memory pass on the phone
        private val PHONE_CANT = setOf("songs", "searches", "cab_filed", "cab_streak", "cab_shredded", "cab_waited")
    }
}
