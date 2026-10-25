package com.efficiencyx.junos.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    private val ca = "AB".repeat(32)

    @Test
    fun readsTheLinkStartShPrints() {
        val link = "junos://pair?mode=lan&name=andrea-pc&token=$token&ca=$ca" +
            "&url=https%3A%2F%2F192.168.1.42%2Fapi%2Fmodel.php&url=https%3A%2F%2Fjun.local%2Fapi%2Fmodel.php"
        val pairing = Pairing.parse(link)!!

        assertEquals(SessionMode.LAN, pairing.mode)
        assertEquals("andrea-pc", pairing.name)
        assertEquals(listOf("https://192.168.1.42/api/model.php", "https://jun.local/api/model.php"), pairing.urls)
        assertEquals(ca.lowercase(), pairing.ca)
        assertEquals("jun", pairing.api)
        assertEquals("192.168.1.42", pairing.host)
    }

    @Test
    fun readsTheNotebookLink() {
        val link = "junos://pair?mode=cloud&name=Colab&token=$token&api=ollama" +
            "&model=hf.co%2Fefficiencyx%2FJun-LoRA-12B-GGUF%3AQ4_K_M&ctx=12288&url=https%3A%2F%2Fa-b-c.trycloudflare.com"
        val pairing = Pairing.parse(link)!!

        assertEquals(SessionMode.CLOUD, pairing.mode)
        assertEquals("ollama", pairing.api)
        assertEquals("hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M", pairing.model)
        assertEquals(12288, pairing.ctx)
        assertNull(pairing.ca)
    }

    @Test
    fun refusesWhatIsntAPairing() {
        val good = "junos://pair?mode=lan&token=$token&url=https%3A%2F%2F10.0.0.2%2Fapi%2Fmodel.php"
        assertEquals(SessionMode.LAN, Pairing.parse(good)?.mode)

        assertNull(Pairing.parse("https://example.com/?mode=lan&token=$token"))
        assertNull(Pairing.parse(good.replace("junos://pair", "junos://other")))
        assertNull(Pairing.parse(good.replace("mode=lan", "mode=what")))
        assertNull(Pairing.parse(good.replace(token, "short")))
        assertNull(Pairing.parse(good.replace("https%3A", "http%3A")))
        assertNull(Pairing.parse(good.replace("https%3A%2F%2F", "https%3A%2F%2Fuser%40")))
        assertNull(Pairing.parse("$good&ca=nothex"))
        assertNull(Pairing.parse("$good&api=ollama&model=x"))
        assertNull(Pairing.parse(good.replace("mode=lan", "mode=cloud") + "&api=openai"))
        assertNull(Pairing.parse("junos://pair?mode=lan&token=$token"))
    }
}
