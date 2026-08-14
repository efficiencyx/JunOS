package com.efficiencyx.junos.memory

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate

class MemoryDatesTest {
    private val monday = LocalDate.of(2026, 8, 10)

    @Test
    fun resolvesTomorrowAgainstTheDayItWasWritten() {
        assertEquals(
            "dentist tomorrow (= Tuesday 11 August 2026, that is tomorrow) at nine",
            MemoryDates.render("dentist tomorrow at nine", monday, today = monday),
        )
    }

    @Test
    fun resolvesTodayAndYesterday() {
        assertEquals(
            "today (= Monday 10 August 2026, that is today)",
            MemoryDates.render("today", monday, today = monday),
        )
        assertEquals(
            "yesterday (= Sunday 9 August 2026, that was yesterday, already past)",
            MemoryDates.render("yesterday", monday, today = monday),
        )
    }

    @Test
    fun resolvesNextWeekdayToTheOneAfterTheNoteDay() {
        assertEquals(
            "call her next friday (= Friday 14 August 2026, that is in 4 days)",
            MemoryDates.render("call her next friday", monday, today = monday),
        )
    }

    @Test
    fun leavesABareWeekdayAlone() {
        assertEquals("gym on friday", MemoryDates.render("gym on friday", monday, today = monday))
    }

    @Test
    fun resolvesCountedDays() {
        assertEquals(
            "results in 3 days (= Thursday 13 August 2026, that is in 3 days)",
            MemoryDates.render("results in 3 days", monday, today = monday),
        )
    }

    @Test
    fun keepsFuzzyPhrasesFuzzy() {
        assertEquals("moving next week", MemoryDates.render("moving next week", monday, today = monday))
        assertEquals("back in a few days", MemoryDates.render("back in a few days", monday, today = monday))
    }

    @Test
    fun readsPastDaysAsPast() {
        assertEquals(
            "fought yesterday (= Friday 31 July 2026, that was 10 days ago, already past)",
            MemoryDates.render("fought yesterday", LocalDate.of(2026, 8, 1), today = monday),
        )
    }

    @Test
    fun stampsOnlyNotesThatLeanOnTheirOwnDate() {
        assertEquals(
            "(noted Saturday 1 August 2026, that was 9 days ago, already past) ",
            MemoryDates.stamp("fought yesterday", LocalDate.of(2026, 8, 1), today = monday),
        )
        assertEquals("", MemoryDates.stamp("he hates coriander", monday, today = monday))
    }

    @Test
    fun passesNotesWithoutRelativeWordsThrough() {
        val text = "he hates coriander and works at [[Facility]]"

        assertEquals(text, MemoryDates.render(text, monday, today = monday))
    }

    @Test
    fun leavesNotesWithNoCreationDateAlone() {
        assertEquals("see you tomorrow", MemoryDates.render("see you tomorrow", MemoryDates.day(0)))
        assertEquals("", MemoryDates.stamp("see you tomorrow", MemoryDates.day(0)))
    }
}
