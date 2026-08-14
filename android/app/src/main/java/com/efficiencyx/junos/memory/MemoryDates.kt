package com.efficiencyx.junos.memory

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.util.Locale

// A note that says "tomorrow" only means anything next to the day it was
// written, and she will NOT do that sum herself: give a 2B model "(noted Monday
// 10 August)" beside the word "tomorrow" and it just says "tomorrow" back, four
// days late. so we work the day out here and paste it right after the phrase.
// This is memory_note_render() from webapp/api/_lib.php in Kotlin, the two
// prompts have to say the same thing, so change them together.
object MemoryDates {
    fun day(created: Long): LocalDate? =
        if (created <= 0) null else Instant.ofEpochSecond(created).atZone(ZoneId.systemDefault()).toLocalDate()

    // Stamping every note costs a whole category off the end of the context
    // budget, so ONLY the notes whose wording leans on their own date get one.
    fun stamp(text: String, created: LocalDate?, today: LocalDate = LocalDate.now()): String {
        if (created == null || !RELATIVE.containsMatchIn(text)) return ""
        return "(noted ${format(created)}, ${daysPhrase(created, today)}) "
    }

    fun render(text: String, created: LocalDate?, today: LocalDate = LocalDate.now()): String {
        if (created == null) return text
        return RELATIVE.replace(text) { match ->
            val day = resolve(match.value.lowercase(Locale.ROOT), created) ?: return@replace match.value
            "${match.value} (= ${format(day)}, ${daysPhrase(day, today)})"
        }
    }

    // "next week" and "in a few days" stay fuzzy on purpose, there is no one day
    // to name, they keep the anchor stamp and nothing else.
    private fun resolve(phrase: String, created: LocalDate): LocalDate? {
        OFFSETS[phrase]?.let { return created.plusDays(it.toLong()) }
        NEXT_WEEKDAY.matchEntire(phrase)?.let { match ->
            val weekday = DayOfWeek.valueOf(match.groupValues[1].uppercase(Locale.ROOT))
            return created.with(TemporalAdjusters.next(weekday))
        }
        val counted = COUNTED.matchEntire(phrase) ?: return null
        val amount = counted.groupValues[1].ifEmpty { counted.groupValues[2] }.toLong()
        return when (counted.groupValues[3]) {
            "day" -> created.plusDays(amount)
            "week" -> created.plusWeeks(amount)
            else -> created.plusMonths(amount)
        }
    }

    private fun daysPhrase(day: LocalDate, today: LocalDate): String {
        val days = ChronoUnit.DAYS.between(today, day)
        return when {
            days == 0L -> "that is today"
            days == 1L -> "that is tomorrow"
            days == -1L -> "that was yesterday, already past"
            days > 1L -> "that is in $days days"
            else -> "that was ${-days} days ago, already past"
        }
    }

    private fun format(day: LocalDate) = FORMAT.format(day)

    private val FORMAT = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", Locale.ENGLISH)

    private val RELATIVE = Regex(
        "\\b(today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|month|weekend)|" +
            "last (?:night|week|month|weekend)|" +
            "next (?:week|month|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|" +
            "in (?:a few|a couple of|\\d{1,2}) (?:days?|weeks?|months?)|days? from now|weeks? from now)\\b",
        RegexOption.IGNORE_CASE,
    )

    private val NEXT_WEEKDAY = Regex("^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$")
    private val COUNTED = Regex("^(?:in (\\d{1,2})|(\\d{1,2})) (day|week|month)s? ?(?:from now)?$")

    private val OFFSETS = mapOf(
        "today" to 0, "tonight" to 0, "this morning" to 0, "this afternoon" to 0,
        "this evening" to 0, "tomorrow" to 1, "yesterday" to -1, "last night" to -1,
    )
}
