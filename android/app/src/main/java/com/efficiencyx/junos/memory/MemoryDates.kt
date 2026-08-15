package com.efficiencyx.junos.memory

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.util.Locale

// a note saying "tomorrow" means nothing without the day it was
// written. Jun is 2B and will absolutely NOT do that sum. give
// her "(noted Monday 10 August)" next to it and she hands back
// "tomorrow", four days late. so we do the maths here and paste
// the real day after the phrase. this is memory_note_render()
// from webapp/api/_lib.php. keep the two prompts together.
object MemoryDates {
    fun day(created: Long): LocalDate? =
        if (created <= 0) null else Instant.ofEpochSecond(created).atZone(ZoneId.systemDefault()).toLocalDate()

    // stamping every note costs a whole category off the context
    // budget, so ONLY notes that lean on their date get one
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

    // "next week" and "in a few days" have no single day to name.
    // they stay fuzzy and keep only the anchor stamp.
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
