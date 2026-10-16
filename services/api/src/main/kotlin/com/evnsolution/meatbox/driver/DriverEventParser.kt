package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus
import tools.jackson.databind.node.ObjectNode

private val EVENT_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
private const val MAX_STOPS = 200
private const val MAX_PHOTOS = 10
private const val MAX_CODES = 200
private const val MAX_ITEMS = 200
private const val NOTE_LENGTH = 500
private const val MAX_QUANTITY = 1_000_000.0
private val STOP_EXTRAS = setOf("orderIds", "photoIds", "note")
internal val REASON_CODES = setOf("ABSENT", "ACCESS_DENIED", "ADDRESS_MISMATCH", "REFUSED", "NO_STORAGE", "OTHER")

internal class DriverEvent(
    val eventId: String,
    val type: String,
    val vehicleId: String,
    val body: ObjectNode,
    val payload: ObjectNode,
) {
    val photoIds: List<String> get() = payload.path("photoIds").toList().map { it.asString() }
}

internal fun validEventId(value: String): Boolean = EVENT_ID.matches(value)

/** Payload shape per event type. State-dependent rules run later, on the snapshot inside the dispatch lock. */
private val PAYLOADS: Map<String, (ObjectNode) -> Unit> = mapOf(
    "departed" to { payload ->
        payload.keys(emptySet(), setOf("stopOrder"))
        payload.stopList("stopOrder", required = false)
    },
    "zone_entered" to { payload ->
        payload.keys(setOf("zoneId"))
        payload.word("zoneId", SHORT_LENGTH)
    },
    "stop_completed" to { payload ->
        payload.keys(setOf("stopId"), STOP_EXTRAS + "scannedCodes")
        payload.stopFields()
        payload.words("scannedCodes", MAX_CODES, CODE_LENGTH)
    },
    "stop_failed" to { payload ->
        payload.keys(setOf("stopId", "reasonCode"), STOP_EXTRAS)
        payload.stopFields()
        if (payload.word("reasonCode", SHORT_LENGTH) !in REASON_CODES) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_REASON_CODE")
        }
    },
    "stop_partially_completed" to { payload ->
        payload.keys(setOf("stopId", "items"), STOP_EXTRAS + "orderId")
        payload.stopFields()
        if (payload.has("orderId")) payload.word("orderId", CODE_LENGTH)
        payload.checkItems()
    },
    "route_reordered" to { payload ->
        payload.keys(setOf("stopOrder"), setOf("expectedRevision"))
        payload.stopList("stopOrder", required = true)
        val expected = payload.get("expectedRevision")
        if (expected != null && !(expected.isIntegralNumber && expected.longValue() >= 0)) invalidInput()
    },
)

/** Checks the envelope and the payload shape of one event. */
internal fun parseEvent(body: ObjectNode, date: String): DriverEvent {
    val eventId = body.str("eventId").also { if (!validEventId(it)) invalidInput() }
    val type = body.str("type")
    val validate = PAYLOADS[type] ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_EVENT_TYPE")
    if (body.str("date") != date) invalidInput()
    val vehicleId = driverText(body.str("vehicleId"), CODE_LENGTH)
    isoTime(body.path("occurredAt"))
    body.get("location")?.let { checkLocation(it) }
    val payload = body.path("payload") as? ObjectNode ?: invalidInput()
    validate(payload)
    return DriverEvent(eventId, type, vehicleId, body, payload)
}

private fun ObjectNode.stopList(key: String, required: Boolean) {
    if (!has(key) && !required) return
    val ids = words(key, MAX_STOPS, CODE_LENGTH)
    if (ids.isEmpty() || ids.toSet().size != ids.size) invalidInput()
}

/** `stopId`, and the optional `orderIds`, `photoIds` and `note` that the stop events share. */
private fun ObjectNode.stopFields() {
    word("stopId", CODE_LENGTH)
    words("orderIds", MAX_STOPS, CODE_LENGTH)
    val photos = words("photoIds", MAX_PHOTOS, CODE_LENGTH)
    if (photos.toSet().size != photos.size || !photos.all(::validPhotoId)) invalidInput()
    if (has("note") && str("note").isNotEmpty()) driverText(str("note"), NOTE_LENGTH)
}

private fun ObjectNode.checkItems() {
    val items = path("items")
    if (!items.isArray || items.isEmpty || items.size() > MAX_ITEMS) invalidInput()
    items.forEach { item ->
        val fields = item as? ObjectNode ?: invalidInput()
        fields.keys(setOf("sku", "deliveredQty", "orderedQty"))
        fields.word("sku", SHORT_LENGTH)
        listOf("deliveredQty", "orderedQty").forEach {
            val quantity = fields.path(it)
            if (!(quantity.isNumber && quantity.doubleValue() in 0.0..MAX_QUANTITY)) invalidInput()
        }
    }
}
