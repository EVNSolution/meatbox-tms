package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.time.OffsetDateTime

internal const val SHORT_LENGTH = 64
internal const val CODE_LENGTH = 128
private const val MAX_LAT = 90.0
private const val MAX_LNG = 180.0
private const val MAX_ACCURACY = 100_000.0

internal fun invalidInput(): Nothing = driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")

/** The object has every `required` key and no key outside `required` and `optional`. */
internal fun ObjectNode.keys(required: Set<String>, optional: Set<String> = emptySet()) {
    val names = properties().map { it.key }.toSet()
    if (!names.containsAll(required) || !(required + optional).containsAll(names)) invalidInput()
}

internal fun ObjectNode.str(key: String): String =
    path(key).takeIf(JsonNode::isString)?.asString() ?: invalidInput()

internal fun ObjectNode.word(key: String, max: Int): String = driverText(str(key), max, allowSpace = false)

internal fun ObjectNode.words(key: String, maxItems: Int, max: Int): List<String> {
    if (!has(key)) return emptyList()
    val array = path(key) as? ArrayNode ?: invalidInput()
    if (array.size() > maxItems) invalidInput()
    return array.toList().map { value ->
        driverText(value.takeIf(JsonNode::isString)?.asString() ?: invalidInput(), max, allowSpace = false)
    }
}

internal fun isoTime(node: JsonNode): OffsetDateTime {
    val text = node.takeIf(JsonNode::isString)?.asString()?.takeIf { it.length <= SHORT_LENGTH } ?: invalidInput()
    return runCatching { OffsetDateTime.parse(text) }.getOrNull() ?: invalidInput()
}

/** `lat`, `lng` and an optional `accuracyM`; a location sample also needs its time `at`. */
internal fun checkLocation(node: JsonNode, sample: Boolean = false) {
    val fields = node as? ObjectNode ?: invalidInput()
    fields.keys(if (sample) setOf("at", "lat", "lng") else setOf("lat", "lng"), setOf("accuracyM"))
    if (sample) isoTime(fields.path("at"))
    val accuracy = fields.get("accuracyM")
    if (!inRange(fields.path("lat"), MAX_LAT) || !inRange(fields.path("lng"), MAX_LNG)) invalidInput()
    if (accuracy != null && !(accuracy.isNumber && accuracy.doubleValue() in 0.0..MAX_ACCURACY)) invalidInput()
}

private fun inRange(node: JsonNode, limit: Double) = node.isNumber && node.doubleValue() in -limit..limit
