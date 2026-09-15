package com.efficiencyx.junos.wardrobe

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

@Serializable
data class WardrobeState(
    val items: Map<String, Boolean>,
    val variants: Map<String, Int>,
    val assets: List<String>,
) {
    companion object {
        fun default() = WardrobeState(Wardrobe.ITEM_DEFAULTS, Wardrobe.VARIANT_MAX.mapValues { 0 }, emptyList())
    }
}

data class ToolOutcome(val state: WardrobeState?, val apply: JsonObject?, val reply: JsonObject)

// port of webapp/api/_wardrobe.php. the tables are the php ones
// verbatim and in the php order, the browser and the model both
// read lists built from them.
object Wardrobe {
    val ITEM_DEFAULTS: Map<String, Boolean> = linkedMapOf(
        "shirt" to true, "hoodie" to false, "dress" to false, "dress1" to false,
        "skirt" to true, "pants" to false, "bra" to true, "panties" to true,
        "bikini_top" to false, "bikini_bot" to false, "shoe_l" to true,
        "shoe_r" to true, "stockings" to true, "headband" to false,
        "wizard_hat" to false, "bow" to false, "choker" to false,
        "cat_ears" to true, "pointy_ears" to false, "tail" to true,
        "hair_hologram" to true, "hair_h0" to true, "hair_h1" to false,
        "hair_h2" to false, "hair_h3" to false, "hair_h4" to false,
    )

    val VARIANT_MAX: Map<String, Int> = linkedMapOf(
        "hair_h0_style" to 1, "arm_style" to 2, "leg_style" to 2, "hightech_skin" to 1,
        "skirt_style" to 1, "sock_style" to 7, "shoe_style" to 2,
        "glasses_style" to 2, "shirt_logo" to 100, "sleeve_logo" to 100,
        "hoodie_logo" to 100, "panties_logo" to 100,
    )

    // pairs that cannot both be on. same list as ITEMS[].excludes in
    // outfit.js, the two have to stay in step or every PUT 400s.
    val CONFLICTS: List<Pair<String, String>> = listOf(
        "dress" to "shirt", "dress" to "hoodie", "dress" to "skirt", "dress" to "pants", "dress" to "dress1",
        "dress1" to "shirt", "dress1" to "hoodie", "dress1" to "skirt", "dress1" to "pants",
        "skirt" to "pants", "bra" to "bikini_top", "panties" to "bikini_bot",
        "headband" to "wizard_hat", "cat_ears" to "pointy_ears",
    )

    val ALIASES: Map<String, List<String>> = linkedMapOf(
        "shoes" to listOf("shoe_l", "shoe_r"),
        "shoe" to listOf("shoe_l", "shoe_r"),
        "shoe_left" to listOf("shoe_l"),
        "left_shoe" to listOf("shoe_l"),
        "shoe_right" to listOf("shoe_r"),
        "right_shoe" to listOf("shoe_r"),
        "hat" to listOf("wizard_hat"),
        "witch_hat" to listOf("wizard_hat"),
        "dress_alt" to listOf("dress1"),
        "alt_dress" to listOf("dress1"),
        "socks" to listOf("stockings"),
        "sock" to listOf("stockings"),
        "catears" to listOf("cat_ears"),
        "cat_ear" to listOf("cat_ears"),
        "pointy_ear" to listOf("pointy_ears"),
        "bikini" to listOf("bikini_top", "bikini_bot"),
        "swimsuit" to listOf("bikini_top", "bikini_bot"),
        "bikini_bottom" to listOf("bikini_bot"),
        "underwear" to listOf("bra", "panties"),
        "top" to listOf("shirt"),
        "t_shirt" to listOf("shirt"),
        "tshirt" to listOf("shirt"),
        "trousers" to listOf("pants"),
        "choker" to listOf("choker"),
        "collar" to listOf("choker"),
        "hair" to listOf("hair_h0"),
    )

    val LABELS: Map<String, String> = linkedMapOf(
        "shoe_l" to "left shoe", "shoe_r" to "right shoe",
        "bikini_top" to "bikini top", "bikini_bot" to "bikini bottom",
        "dress1" to "alt dress", "wizard_hat" to "witch hat",
        "hair_h0" to "default hair", "hair_h1" to "side swept hair",
        "hair_h2" to "front bang", "hair_h3" to "hime cut hair",
        "hair_h4" to "ponytail", "hair_hologram" to "hair hologram",
        "choker" to "bell choker",
    )

    // "nude" means these and only these. ears and tail stay.
    val CLOTHING: List<String> = listOf(
        "shirt", "hoodie", "dress", "dress1", "skirt", "pants", "bra", "panties",
        "bikini_top", "bikini_bot", "shoe_l", "shoe_r", "stockings", "headband",
        "wizard_hat", "bow", "choker",
    )

    val STRIP_WORDS: List<String> = listOf("nude", "naked", "everything", "all", "clothes", "all clothes", "undress")

    private val ASSET_PATH = Regex("^variants/[A-Za-z0-9_./-]+\\.png$")
    private val NOT_KEY = Regex("[^a-z0-9]+")

    fun label(key: String) = LABELS[key] ?: key.replace('_', ' ')

    fun excludes(key: String) = CONFLICTS.mapNotNull { (left, right) ->
        when (key) { left -> right; right -> left; else -> null }
    }

    fun resolveItem(name: String): List<String> {
        val key = name.trim().lowercase().replace(NOT_KEY, "_").trim('_')
        if (key.isEmpty()) return emptyList()
        ALIASES[key]?.let { return it }
        if (key in ITEM_DEFAULTS) return listOf(key)
        // the tool hands her the LABELS as the list of what exists,
        // so every label has to come back
        return LABELS.entries.firstOrNull { it.value.replace(' ', '_') == key }?.let { listOf(it.key) } ?: emptyList()
    }

    fun matchMod(name: String, modItems: List<String>): String? {
        val want = name.trim().lowercase()
        modItems.firstOrNull { it.lowercase() == want }?.let { return it }
        return modItems.firstOrNull {
            val label = it.lowercase()
            label.length >= 4 && (want in label || label in want)
        }
    }

    // returns the keys that actually moved
    fun setItem(items: MutableMap<String, Boolean>, key: String, on: Boolean): List<String> {
        val moved = mutableListOf<String>()
        if (items[key] != on) {
            items[key] = on
            moved += key
        }
        if (!on) return moved
        for (other in excludes(key)) {
            if (items[other] != true) continue
            items[other] = false
            moved += other
        }
        return moved
    }

    fun worn(state: WardrobeState) = state.items.filterValues { it }.keys.map(::label)

    private fun JsonElement.asBool() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    private fun JsonElement.asInt() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    // null wherever php fails 400 invalid_wardrobe
    fun canonicalState(input: JsonObject): WardrobeState? {
        val items = input["items"]?.let { it as? JsonObject ?: return null } ?: JsonObject(emptyMap())
        val variants = input["variants"]?.let { it as? JsonObject ?: return null } ?: JsonObject(emptyMap())
        val assets = input["assets"]?.let { it as? JsonArray ?: return null } ?: JsonArray(emptyList())
        val hairClip = items["hair_clip"]?.let { it.asBool() ?: return null }

        val outItems = LinkedHashMap(ITEM_DEFAULTS)
        for (key in ITEM_DEFAULTS.keys) {
            val value = items[key] ?: continue
            outItems[key] = value.asBool() ?: return null
        }
        val outVariants = LinkedHashMap(VARIANT_MAX.mapValues { 0 })
        for ((key, max) in VARIANT_MAX) {
            val raw = variants[key] ?: continue
            val value = raw.asInt() ?: return null
            if (value < 0 || value > max) return null
            outVariants[key] = value
        }
        if ("hair_h0_style" !in variants && hairClip == true) outVariants["hair_h0_style"] = 1

        if (CONFLICTS.any { (left, right) -> outItems[left] == true && outItems[right] == true }) return null

        // php also checks each asset against the items/variants it
        // belongs to. skipped here: the phone serves /assets/ ungated,
        // this list is only echoed back to the browser, never enforced.
        val clean = LinkedHashSet<String>()
        for (asset in assets) {
            val path = (asset as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            if (!ASSET_PATH.matches(path) || ".." in path) return null
            clean += path
        }
        if (clean.size > 80) return null
        return WardrobeState(outItems, outVariants, clean.sorted())
    }

    // lenient merge over defaults. never rejects, a bad stored row
    // must not kill a chat turn halfway through the stream
    fun toolState(raw: WardrobeState?): WardrobeState {
        val base = WardrobeState.default()
        if (raw == null) return base
        return WardrobeState(
            base.items + raw.items.filterKeys { it in ITEM_DEFAULTS },
            base.variants + raw.variants.filterKeys { it in VARIANT_MAX },
            raw.assets,
        )
    }

    private fun toolNames(value: JsonElement?): List<String> {
        val list = when (value) {
            is JsonPrimitive -> if (value.isString) listOf(value) else return emptyList()
            is JsonArray -> value
            else -> return emptyList()
        }
        return list.asSequence()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
            .filter { it.isNotEmpty() && it.length <= 80 }
            .take(12)
            .toList()
    }

    private fun strings(values: Collection<String>) = buildJsonArray { values.forEach { add(JsonPrimitive(it)) } }

    // the change_outfit tool. every answer is computed against the
    // state the browser last wrote, so what she reads back is her
    // actual clothes and not what she hoped happened. outcome.state
    // is non-null only when something has to be saved.
    fun toolChange(state: WardrobeState, args: JsonObject, modItems: List<String>, presets: Map<String, JsonObject>): ToolOutcome {
        val look = (args["look"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        if (look.isNotEmpty()) {
            val hit = presets.keys.firstOrNull { it.equals(look, ignoreCase = true) }
                ?: presets.keys.firstOrNull { it.contains(look, ignoreCase = true) }
            if (hit == null) {
                return ToolOutcome(null, null, buildJsonObject {
                    put("changed", false)
                    put("error", "no_saved_look_by_that_name")
                    put("saved_looks", strings(presets.keys))
                    put("note", if (presets.isNotEmpty())
                        "You are still wearing exactly what you had on. Use one of the names in saved_looks, or put_on/take_off instead."
                    else
                        "You are still wearing exactly what you had on. There are no saved looks at all - use put_on and take_off.")
                })
            }
            val preset = presets.getValue(hit)
            val items = LinkedHashMap(state.items)
            val variants = LinkedHashMap(state.variants)
            (preset["items"] as? JsonObject)?.forEach { (key, value) ->
                if (key in ITEM_DEFAULTS) value.asBool()?.let { items[key] = it }
            }
            (preset["variants"] as? JsonObject)?.forEach { (key, value) ->
                if (key in VARIANT_MAX) value.asInt()?.let { variants[key] = it }
            }
            val next = WardrobeState(items, variants, state.assets)
            return ToolOutcome(next, buildJsonObject { put("look", hit) }, buildJsonObject {
                put("changed", true)
                put("look", hit)
                put("wearing", strings(worn(next)))
            })
        }

        val items = LinkedHashMap(state.items)
        val applyItems = LinkedHashMap<String, Boolean>()
        val applyMods = LinkedHashMap<String, Boolean>()
        val put = mutableListOf<String>()
        val took = mutableListOf<String>()
        val already = mutableListOf<String>()
        val unknown = mutableListOf<String>()

        for ((names, on) in listOf(toolNames(args["put_on"]) to true, toolNames(args["take_off"]) to false)) {
            for (name in names) {
                // "nude" means the same thing whichever list she put it in
                if (name.lowercase() in STRIP_WORDS) {
                    for (key in CLOTHING) for (moved in setItem(items, key, false)) {
                        applyItems[moved] = false
                        took += label(moved)
                    }
                    continue
                }
                val keys = resolveItem(name)
                if (keys.isEmpty()) {
                    val mod = matchMod(name, modItems)
                    if (mod == null) { unknown += name; continue }
                    applyMods[mod] = on
                    if (on) put += mod else took += mod
                    continue
                }
                val moved = keys.flatMap { setItem(items, it, on) }
                if (moved.isEmpty()) { already += label(keys[0]); continue }
                for (key in moved) {
                    applyItems[key] = items.getValue(key)
                    if (items.getValue(key)) put += label(key) else took += label(key)
                }
            }
        }

        val next = WardrobeState(items, state.variants, state.assets)
        val changed = applyItems.isNotEmpty() || applyMods.isNotEmpty()
        val wearing = worn(next) + modItems.filter { applyMods[it] == true }
        val reply = buildJsonObject {
            put("changed", changed)
            put("put_on", strings(put.distinct()))
            put("took_off", strings(took.distinct()))
            put("wearing", strings(wearing))
            if (already.isNotEmpty()) {
                put("already_like_that", strings(already.distinct()))
                put("note", "The items in already_like_that were in that state before you asked. Do not announce a change you did not make.")
            }
            if (unknown.isNotEmpty()) {
                put("unknown", strings(unknown.distinct()))
                put("valid_items", strings(ITEM_DEFAULTS.keys.map(::label)))
                if (modItems.isNotEmpty()) put("your_special_items", strings(modItems.take(40)))
                put("note", "You do not own the names in unknown and nothing about them changed. Only names from valid_items" +
                    (if (modItems.isNotEmpty()) " or your_special_items" else "") + " exist. Say so plainly rather than pretending.")
            }
            if (!changed && unknown.isEmpty() && already.isEmpty()) {
                put("note", "You named nothing to change, so nothing changed. wearing is what you have on right now.")
            }
        }
        val apply = if (changed) buildJsonObject {
            put("items", JsonObject(applyItems.mapValues { JsonPrimitive(it.value) }))
            put("mods", JsonObject(applyMods.mapValues { JsonPrimitive(it.value) }))
        } else null
        return ToolOutcome(if (applyItems.isNotEmpty()) next else null, apply, reply)
    }
}
