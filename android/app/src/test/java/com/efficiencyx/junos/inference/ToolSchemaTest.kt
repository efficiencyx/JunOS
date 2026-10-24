package com.efficiencyx.junos.inference

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ToolSchemaTest {
    @Test
    fun litertGetsTheBareFunctionDeclaration() {
        for (schema in ChatEngine.TOOL_SCHEMAS) {
            val wrapped = Json.parseToJsonElement(schema).jsonObject
            val bare = Json.parseToJsonElement(toolDescription(schema)).jsonObject

            assertEquals(wrapped["function"]!!.jsonObject["name"]!!.jsonPrimitive.content, bare["name"]!!.jsonPrimitive.content)
            assertFalse("type" in bare)
        }
    }
}
