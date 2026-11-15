package com.efficiencyx.junos

import android.content.res.Configuration
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.efficiencyx.junos.away.AwayTexts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

@RunWith(AndroidJUnit4::class)
class AwayTextsLocaleTest {
    private val app = InstrumentationRegistry.getInstrumentation().targetContext

    private fun inLocale(tag: String) = app.createConfigurationContext(
        Configuration(app.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }
    )

    private fun all(tag: String) = AwayTexts.FALLBACK.flatMap { (tier, sets) ->
        sets.indices.flatMap { AwayTexts.fallback(inLocale(tag), tier, it) }
    }

    @Test
    fun everyLocaleHasItsOwnFallbacks() {
        val english = all("en")
        assertEquals("Hey. Just checking you're still out there.", english.first())
        for (tag in listOf("it", "de", "ja", "fr", "es", "pt", "hi", "zh")) {
            val local = all(tag)
            assertEquals(tag, english.size, local.size)
            val same = english.zip(local).count { (en, l) -> en == l }
            assertNotEquals(tag, english.first(), local.first())
            assert(same <= 3) { "$tag: $same lines still english" }
            assertEquals(tag, english.count { "{f_playerName}" in it }, local.count { "{f_playerName}" in it })
        }
    }
}
