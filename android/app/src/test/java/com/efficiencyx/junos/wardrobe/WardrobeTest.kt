package com.efficiencyx.junos.wardrobe

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WardrobeTest {
    private fun args(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun strings(value: JsonArray) = value.map { it.jsonPrimitive.content }
    private fun change(text: String, mods: List<String> = emptyList(), presets: Map<String, JsonObject> = emptyMap()) =
        Wardrobe.toolChange(WardrobeState.default(), args(text), mods, presets)

    @Test
    fun dressTakesOffShirtAndSkirt() {
        val out = change("""{"put_on":["dress"]}""")

        assertTrue(out.reply["changed"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("dress"), strings(out.reply["put_on"]!!.jsonArray))
        assertEquals(listOf("shirt", "skirt"), strings(out.reply["took_off"]!!.jsonArray))
        assertNotNull(out.state)
        assertTrue(out.state!!.items.getValue("dress"))
        assertFalse(out.state!!.items.getValue("shirt"))
        val items = out.apply!!["items"]!!.jsonObject
        assertEquals(setOf("dress", "shirt", "skirt"), items.keys)
        assertFalse(items["skirt"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun nudeStripsClothingOnly() {
        val out = change("""{"take_off":["nude"]}""")

        val state = out.state!!
        assertTrue(Wardrobe.CLOTHING.none { state.items.getValue(it) })
        assertTrue(state.items.getValue("cat_ears"))
        assertTrue(state.items.getValue("tail"))
        assertTrue(state.items.getValue("hair_h0"))
        val wearing = strings(out.reply["wearing"]!!.jsonArray)
        assertEquals(listOf("cat ears", "tail", "hair hologram", "default hair"), wearing)
    }

    @Test
    fun alreadyOnItemChangesNothing() {
        val out = change("""{"put_on":"shirt"}""")

        assertFalse(out.reply["changed"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("shirt"), strings(out.reply["already_like_that"]!!.jsonArray))
        assertNull(out.state)
        assertNull(out.apply)
        assertTrue(out.reply["note"]!!.jsonPrimitive.content.startsWith("The items in already_like_that"))
    }

    @Test
    fun unknownNameIsReportedWithValidItems() {
        val out = change("""{"put_on":["tiara"]}""")

        assertEquals(listOf("tiara"), strings(out.reply["unknown"]!!.jsonArray))
        val valid = strings(out.reply["valid_items"]!!.jsonArray)
        assertEquals(Wardrobe.ITEM_DEFAULTS.size, valid.size)
        assertTrue("bell choker" in valid)
        assertNull(out.reply["your_special_items"])
        assertNull(out.apply)
    }

    @Test
    fun unknownNameMatchesModItemCaseInsensitively() {
        val out = change("""{"put_on":["cyber tiara"]}""", mods = listOf("Cyber Tiara", "Halo"))

        assertNull(out.reply["unknown"])
        assertTrue(out.reply["changed"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("Cyber Tiara"), strings(out.reply["put_on"]!!.jsonArray))
        assertTrue(out.apply!!["mods"]!!.jsonObject["Cyber Tiara"]!!.jsonPrimitive.boolean)
        assertTrue("Cyber Tiara" in strings(out.reply["wearing"]!!.jsonArray))
        assertNull(out.state)
    }

    @Test
    fun lookResolvesCaseInsensitivelyAndBySubstring() {
        val presets = linkedMapOf(
            "Beach Day" to obj("""{"items":{"bikini_top":true,"bikini_bot":true,"bogus":true},"variants":{"sock_style":3}}"""),
            "Witch" to obj("""{"items":{"wizard_hat":true}}"""),
        )

        val exact = change("""{"look":"beach day"}""", presets = presets)
        assertEquals("Beach Day", exact.reply["look"]!!.jsonPrimitive.content)
        assertEquals("Beach Day", exact.apply!!["look"]!!.jsonPrimitive.content)
        assertTrue(exact.state!!.items.getValue("bikini_top"))
        assertEquals(3, exact.state!!.variants.getValue("sock_style"))
        assertFalse("bogus" in exact.state!!.items)

        val partial = change("""{"look":"itc"}""", presets = presets)
        assertEquals("Witch", partial.reply["look"]!!.jsonPrimitive.content)

        val miss = change("""{"look":"gala"}""", presets = presets)
        assertFalse(miss.reply["changed"]!!.jsonPrimitive.boolean)
        assertEquals("no_saved_look_by_that_name", miss.reply["error"]!!.jsonPrimitive.content)
        assertEquals(listOf("Beach Day", "Witch"), strings(miss.reply["saved_looks"]!!.jsonArray))
        assertNull(miss.state)
        assertNull(miss.apply)
    }

    @Test
    fun labelsResolveBackToKeys() {
        assertEquals(listOf("choker"), Wardrobe.resolveItem("bell choker"))
        assertEquals(listOf("shoe_l", "shoe_r"), Wardrobe.resolveItem("Shoes"))
        assertEquals(listOf("hair_h1"), Wardrobe.resolveItem("side-swept hair"))
        assertTrue(Wardrobe.resolveItem("???").isEmpty())
    }

    @Test
    fun canonicalStateRejectsConflictsAndBadVariants() {
        assertNull(Wardrobe.canonicalState(obj("""{"items":{"dress":true,"shirt":true}}""")))
        assertNull(Wardrobe.canonicalState(obj("""{"variants":{"sock_style":8}}""")))
        assertNull(Wardrobe.canonicalState(obj("""{"variants":{"sock_style":"3"}}""")))
        assertNull(Wardrobe.canonicalState(obj("""{"items":{"shirt":"true"}}""")))
        assertNull(Wardrobe.canonicalState(obj("""{"assets":["variants/../x.png"]}""")))
        assertNull(Wardrobe.canonicalState(obj("""{"items":[]}""")))
    }

    @Test
    fun canonicalStateUpgradesLegacyHairClip() {
        val state = Wardrobe.canonicalState(obj("""{"items":{"hair_clip":true,"shirt":false},"assets":["variants/b.png","variants/a.png","variants/b.png"]}"""))!!

        assertEquals(1, state.variants.getValue("hair_h0_style"))
        assertFalse("hair_clip" in state.items)
        assertFalse(state.items.getValue("shirt"))
        assertEquals(Wardrobe.ITEM_DEFAULTS.keys.toList(), state.items.keys.toList())
        assertEquals(listOf("variants/a.png", "variants/b.png"), state.assets)
    }

    @Test
    fun stateRoundTripsThroughJson() {
        val json = Json { ignoreUnknownKeys = true }
        val encoded = json.encodeToString(WardrobeState.serializer(), WardrobeState.default())
        val decoded = json.decodeFromString(WardrobeState.serializer(), encoded)

        assertEquals(WardrobeState.default(), decoded)
        assertEquals(WardrobeState.default(), Wardrobe.toolState(WardrobeState(mapOf("shirt" to true, "junk" to true), emptyMap(), emptyList())))
        assertEquals(JsonPrimitive(true), Json.parseToJsonElement(encoded).jsonObject["items"]!!.jsonObject["shirt"])
    }
}
