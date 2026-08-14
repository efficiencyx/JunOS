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

@Entity(tableName = "memory_consolidation")
data class ConsolidationEntity(
    @PrimaryKey val id: Int = 1,
    val enabled: Boolean = true,
    val lastActivity: Long = 0,
    val lastRun: Long = 0,
    val lastStatus: String = "never",
    val lastNoteCount: Int = 0,
)

@Dao
abstract class JunDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT :limit")
    abstract suspend fun conversations(limit: Int = 100): List<ConversationEntity>

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
    abstract suspend fun putRelationship(value: RelationshipEntity)

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

    @Query("SELECT * FROM memory_consolidation WHERE id = 1")
    abstract suspend fun consolidation(): ConsolidationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putConsolidation(value: ConsolidationEntity)

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
        WardrobePresetEntity::class,
        ConsolidationEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class JunDatabase : RoomDatabase() {
    abstract fun dao(): JunDao

    companion object {
        fun create(context: Context): JunDatabase = Room.databaseBuilder(
            context.applicationContext,
            JunDatabase::class.java,
            "jun.db",
        ).build()
    }
}
