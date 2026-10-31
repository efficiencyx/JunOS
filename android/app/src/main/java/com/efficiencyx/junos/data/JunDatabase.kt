package com.efficiencyx.junos.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Update
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String? = null,
    val summary: String? = null,
    val summaryUptoId: Long = 0,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(
            entity = ConversationEntity::class,
            parentColumns = ["id"],
            childColumns = ["conversationId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["conversationId", "id"])],
)
data class MessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val conversationId: Long,
    val role: String,
    val content: String,
    val createdAt: Long,
)

@Entity(tableName = "preferences")
data class PreferenceEntity(
    @PrimaryKey val id: Int = 1,
    val data: String,
)

@Entity(tableName = "relationship")
data class RelationshipEntity(
    @PrimaryKey val id: Int = 1,
    val affection: Int = 60,
    val trust: Int = 50,
    val tension: Int = 20,
    val updatedAt: Long = 0,
)

@Entity(tableName = "relationship_history")
data class RelationshipHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val affection: Int,
    val trust: Int,
    val tension: Int,
    val event: String? = null,
    val at: Long,
)

@Entity(
    tableName = "wardrobe_presets",
    indices = [Index(value = ["name"], unique = true)],
)
data class WardrobePresetEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val data: String,
    val updatedAt: Long,
)

@Entity(tableName = "wardrobe_state")
data class WardrobeStateEntity(
    @PrimaryKey val id: Int = 1,
    val data: String,
    val updatedAt: Long,
)

@Entity(tableName = "memory_consolidation")
data class ConsolidationEntity(
    @PrimaryKey val id: Int = 1,
    val enabled: Boolean = true,
    val lastActivity: Long = 0,
    val lastRun: Long = 0,
    val lastStatus: String = "never",
    val lastNoteCount: Int = 0,
)

@Entity(tableName = "achievement_stats")
data class AchievementStatEntity(
    @PrimaryKey val stat: String,
    val value: Long,
    val updatedAt: Long,
)

@Entity(tableName = "achievement_seen")
data class AchievementSeenEntity(
    @PrimaryKey val ach: String,
    val tier: Int,
)

@Entity(
    tableName = "reply_ratings",
    indices = [Index(value = ["messageId"], unique = true)],
)
data class ReplyRatingEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val conversationId: Long,
    val messageId: Long,
    val rating: Int,
    val model: String? = null,
    val context: String,
    val reply: String,
    val at: Long,
)

@Entity(tableName = "planned_messages")
data class PlannedMessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val text: String,
    val dueAt: Long,
    val createdAt: Long,
    val deliveredAt: Long? = null,
)

@Dao
abstract class JunDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC, id DESC LIMIT :limit")
    abstract suspend fun conversations(limit: Int = 100): List<ConversationEntity>

    @Query(
        "SELECT * FROM conversations WHERE updatedAt < :before OR (updatedAt = :before AND id < :beforeId) " +
            "ORDER BY updatedAt DESC, id DESC LIMIT :limit",
    )
    abstract suspend fun conversationsBefore(before: Long, beforeId: Long, limit: Int = 100): List<ConversationEntity>

    @Query("SELECT * FROM conversations WHERE id = :id")
    abstract suspend fun conversation(id: Long): ConversationEntity?

    @Insert
    abstract suspend fun insertConversation(value: ConversationEntity): Long

    @Update
    abstract suspend fun updateConversation(value: ConversationEntity): Int

    @Query("UPDATE conversations SET title = :title, updatedAt = :updatedAt WHERE id = :id")
    abstract suspend fun renameConversation(id: Long, title: String, updatedAt: Long): Int

    @Query("UPDATE conversations SET summary = :summary, summaryUptoId = :uptoId WHERE id = :id")
    abstract suspend fun updateSummary(id: Long, summary: String, uptoId: Long): Int

    @Query("DELETE FROM conversations WHERE id = :id")
    abstract suspend fun deleteConversation(id: Long): Int

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY id")
    abstract suspend fun messages(conversationId: Long): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND id > :afterId ORDER BY id")
    abstract suspend fun messagesAfter(conversationId: Long, afterId: Long): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE content LIKE '%' || :query || '%' ORDER BY id DESC LIMIT :limit")
    abstract suspend fun searchMessages(query: String, limit: Int): List<MessageEntity>

    @Insert
    abstract suspend fun insertMessage(value: MessageEntity): Long

    @Query(
        "DELETE FROM messages WHERE id = (SELECT id FROM messages " +
            "WHERE conversationId = :conversationId AND role = 'assistant' ORDER BY id DESC LIMIT 1)",
    )
    abstract suspend fun deleteLastAssistant(conversationId: Long): Int

    @Query("SELECT * FROM preferences WHERE id = 1")
    abstract suspend fun preferences(): PreferenceEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putPreferences(value: PreferenceEntity)

    @Query("SELECT * FROM relationship WHERE id = 1")
    abstract suspend fun relationship(): RelationshipEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun replaceRelationship(value: RelationshipEntity)

    @Insert
    protected abstract suspend fun insertHistory(value: RelationshipHistoryEntity): Long

    @Query("DELETE FROM relationship_history WHERE id <= (SELECT id FROM relationship_history ORDER BY id DESC LIMIT 1 OFFSET 2000)")
    protected abstract suspend fun trimHistory()

    @Query("SELECT * FROM relationship_history ORDER BY at, id")
    abstract suspend fun relationshipHistory(): List<RelationshipHistoryEntity>

    // same as relationship_set() in php: a timeline row only when a gauge actually moved
    @Transaction
    open suspend fun putRelationship(value: RelationshipEntity) {
        val old = relationship()
        replaceRelationship(value)
        if (old == null || old.affection != value.affection || old.trust != value.trust || old.tension != value.tension) {
            insertHistory(RelationshipHistoryEntity(affection = value.affection, trust = value.trust, tension = value.tension, at = value.updatedAt))
            trimHistory()
        }
    }

    @Query("SELECT * FROM wardrobe_presets ORDER BY updatedAt DESC")
    abstract suspend fun wardrobePresets(): List<WardrobePresetEntity>

    @Query("SELECT * FROM wardrobe_presets WHERE name = :name")
    abstract suspend fun wardrobePreset(name: String): WardrobePresetEntity?

    @Query("SELECT COUNT(*) FROM wardrobe_presets")
    abstract suspend fun wardrobePresetCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putWardrobePreset(value: WardrobePresetEntity): Long

    @Query("DELETE FROM wardrobe_presets WHERE id = :id")
    abstract suspend fun deleteWardrobePreset(id: Long): Int

    @Query("SELECT * FROM wardrobe_state WHERE id = 1")
    abstract suspend fun wardrobeState(): WardrobeStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putWardrobeState(value: WardrobeStateEntity)

    @Query("SELECT * FROM memory_consolidation WHERE id = 1")
    abstract suspend fun consolidation(): ConsolidationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putConsolidation(value: ConsolidationEntity)

    @Query("SELECT * FROM achievement_stats")
    abstract suspend fun achievementStats(): List<AchievementStatEntity>

    @Query("SELECT * FROM achievement_stats WHERE stat = :stat")
    abstract suspend fun achievementStat(stat: String): AchievementStatEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putAchievementStat(value: AchievementStatEntity)

    @Query("DELETE FROM achievement_stats WHERE stat = :stat")
    abstract suspend fun deleteAchievementStat(stat: String)

    @Query("SELECT * FROM achievement_seen")
    abstract suspend fun achievementSeen(): List<AchievementSeenEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putAchievementSeen(value: AchievementSeenEntity)

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    abstract suspend fun lastAssistant(conversationId: Long): MessageEntity?

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND id < :beforeId ORDER BY id DESC LIMIT :limit")
    abstract suspend fun messagesBefore(conversationId: Long, beforeId: Long, limit: Int): List<MessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putRating(value: ReplyRatingEntity)

    @Query("DELETE FROM reply_ratings WHERE messageId = :messageId")
    abstract suspend fun deleteRating(messageId: Long)

    @Query("SELECT * FROM reply_ratings WHERE messageId = :messageId")
    abstract suspend fun rating(messageId: Long): ReplyRatingEntity?

    @Query("SELECT * FROM reply_ratings ORDER BY id")
    abstract suspend fun ratings(): List<ReplyRatingEntity>

    @Query("SELECT COUNT(*) FROM planned_messages WHERE deliveredAt IS NULL")
    protected abstract suspend fun plannedWaiting(): Int

    @Insert
    protected abstract suspend fun insertPlanned(value: PlannedMessageEntity): Long

    // null when max texts are already waiting, same cap as planned_add() in php
    @Transaction
    open suspend fun planMessage(value: PlannedMessageEntity, max: Int): Long? =
        if (plannedWaiting() >= max) null else insertPlanned(value)

    @Query("UPDATE planned_messages SET deliveredAt = :at WHERE id = :id AND deliveredAt IS NULL")
    abstract suspend fun markPlannedDelivered(id: Long, at: Long): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    protected abstract suspend fun insertRelationship(value: RelationshipEntity): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    protected abstract suspend fun insertConsolidation(value: ConsolidationEntity): Long

    @Transaction
    open suspend fun ensureDefaults(now: Long) {
        insertRelationship(RelationshipEntity(updatedAt = now))
        insertConsolidation(ConsolidationEntity(lastActivity = now))
    }
}

@Database(
    entities = [
        ConversationEntity::class,
        MessageEntity::class,
        PreferenceEntity::class,
        RelationshipEntity::class,
        RelationshipHistoryEntity::class,
        WardrobePresetEntity::class,
        WardrobeStateEntity::class,
        ConsolidationEntity::class,
        AchievementStatEntity::class,
        AchievementSeenEntity::class,
        ReplyRatingEntity::class,
        PlannedMessageEntity::class,
    ],
    version = 5,
    exportSchema = true,
)
abstract class JunDatabase : RoomDatabase() {
    abstract fun dao(): JunDao

    companion object {
        fun create(context: Context): JunDatabase = Room.databaseBuilder(
            context.applicationContext,
            JunDatabase::class.java,
            "jun.db",
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5).build()

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `wardrobe_state` (`id` INTEGER NOT NULL, `data` TEXT NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `relationship_history` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `affection` INTEGER NOT NULL, `trust` INTEGER NOT NULL, `tension` INTEGER NOT NULL, `event` TEXT, `at` INTEGER NOT NULL)")
            }
        }

        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `achievement_stats` (`stat` TEXT NOT NULL, `value` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`stat`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `achievement_seen` (`ach` TEXT NOT NULL, `tier` INTEGER NOT NULL, PRIMARY KEY(`ach`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `reply_ratings` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `conversationId` INTEGER NOT NULL, `messageId` INTEGER NOT NULL, `rating` INTEGER NOT NULL, `model` TEXT, `context` TEXT NOT NULL, `reply` TEXT NOT NULL, `at` INTEGER NOT NULL)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_reply_ratings_messageId` ON `reply_ratings` (`messageId`)")
            }
        }

        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `planned_messages` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `text` TEXT NOT NULL, `dueAt` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, `deliveredAt` INTEGER)")
            }
        }
    }
}
