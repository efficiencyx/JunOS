package com.efficiencyx.junos.inference

data class Trip(val where: String, val since: Long, val conversationId: Long)

// lib/chat/tools.php and lib/trips.php, ported. the grant only lives
// as long as the process, a killed app is a walk home anyway
object Trips {
    @Volatile var current: Trip? = null

    val TOOLS = mapOf("enter_shop" to "shop", "enter_karaoke" to "karaoke", "go_out_to_eat" to "date", "play_cards" to "cards")

    private const val APOS = "['’]?"
    private val WORDS = mapOf(
        "shop" to "annalie|shop|shopping|boutique|clothes store|buy (?:you )?(?:some )?clothes",
        "karaoke" to "karaoke|sing together|sing with me|sing a song|go singing",
        "date" to "dinner|lunch|restaurant|eat out|go out to eat|grab (?:a bite|food|something to eat)",
        "cards" to "blackjack|cards|card game",
    ).mapValues { Regex("\\b(?:${it.value})\\b") }
    private val TAG = Regex("\\[[^]]*]")
    private val NOT_A_NO = Regex("why (?:not|don${APOS}t we)|can${APOS}t wait|not gonna say no")
    private val NO = Regex("\\b(?:no|nope|not|never|don${APOS}t|do not|can${APOS}t|won${APOS}t|rather not|later|another time|tomorrow)\\b")
    private val INVITE = Regex(
        "\\b(?:wanna|want to|let${APOS}s|shall we|should we|how about|what about|why don${APOS}t we|come with me|take you|feel like|up for|go (?:to|for|out))\\b",
    )
    private val SHORT_YES = Regex(
        "^\\W*(?:yes|yeah|yea|yep|yup|sure|ok|okay|alright|of course|let${APOS}s go|let${APOS}s do it|sounds good|deal|why not|i${APOS}d love|absolutely|definitely|gladly)\\b",
    )
    private val ACCEPTS = Regex(
        "\\b(?:yes|yeah|yay|sure|okay|ok|alright|of course|let${APOS}s go|let${APOS}s do it|lead the way|grab my (?:coat|bag|jacket)|" +
            "i${APOS}d love (?:to|that)|i${APOS}m in|count me in|deal|gladly|absolutely|definitely|can${APOS}t wait|you${APOS}re on|" +
            "i${APOS}ll (?:go|come)|i${APOS}m (?:going|coming)(?! to\\b))\\b",
    )

    fun wordsIn(text: String): List<String> {
        val clean = TAG.replace(text, " ").lowercase()
        return WORDS.filterValues { it.containsMatchIn(clean) }.keys.toList()
    }

    fun hasNo(text: String) = NO.containsMatchIn(NOT_A_NO.replace(text.lowercase(), ""))

    fun guessInvite(his: String, herLast: String): String {
        val text = his.trim().lowercase()
        if (text.isEmpty() || hasNo(text)) return ""
        val named = wordsIn(text)
        if (named.size == 1 && INVITE.containsMatchIn(text)) return named[0]
        if (text.length <= 80 && '?' in herLast && SHORT_YES.containsMatchIn(text)) {
            val offered = wordsIn(herLast)
            if (offered.size == 1) return offered[0]
            if (named.size == 1 && named[0] in offered) return named[0]
        }
        return ""
    }

    fun replyAccepts(reply: String): Boolean {
        val clean = TAG.replace(reply, " ").lowercase()
        return !hasNo(clean) && ACCEPTS.containsMatchIn(clean)
    }
}
