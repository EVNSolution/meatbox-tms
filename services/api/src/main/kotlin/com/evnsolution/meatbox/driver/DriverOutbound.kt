package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.OutboundDraft
import com.evnsolution.meatbox.dispatch.deliveryStatusBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode

private val STATUS = mapOf(
    "stop_completed" to "delivered",
    "stop_partially_completed" to "partially_delivered",
    "stop_failed" to "failed",
)

/** Where Meatbox is told to fetch a date's photos. The route needs a session until signed links exist. */
internal fun photoBase(origin: String, date: String): String = "$origin/api/dispatch-data/days/$date/driver/photos/"

/**
 * The delivery-status messages (contract 3.1) that one applied event owes Meatbox, one per order. Events that do not
 * change an order's state (`zone_entered`, `route_reordered`) owe none. A bundled stop closes as a whole, so every
 * order of the stop is told, except a partial completion that names its order.
 */
internal fun deliveryMessages(
    event: DriverEvent,
    handled: RouteStop?,
    after: Route,
    photoBase: String,
): List<OutboundDraft> {
    val occurredAt = event.body.path("occurredAt").asString()
    fun draft(orderId: String, status: String) =
        OutboundDraft("delivery-status", orderId, deliveryStatusBody(orderId, status, occurredAt, event.vehicleId))
    val status = STATUS[event.type]
    return when {
        event.type == "departed" -> after.stops.flatMap { it.deliveries }
            .filter { it.path("status").asString() in setOf("current", "pending") }
            .map { draft(it.path("id").asString(), "departed") }
        status == null -> emptyList()
        else -> {
            val payload = event.payload
            val named = event.type == "stop_partially_completed" && payload.has("orderId")
            val orders = if (named) listOf(payload.path("orderId").asString()) else handled!!.orderIds
            orders.map { id -> draft(id, status).also { fill(it.body, event, photoBase) } }
        }
    }
}

/** Photos, note, and the items or failure of the event's type. */
private fun fill(body: ObjectNode, event: DriverEvent, photoBase: String) {
    val payload = event.payload
    val note = payload.path("note").asString("").ifEmpty { null }
    body.set("photos", driverJson.createArrayNode().apply { event.photoIds.forEach { add(photoBase + it) } })
    note?.let { body.put("note", it) }
    if (event.type == "stop_partially_completed") body.set("items", items(payload.path("items")))
    if (event.type == "stop_failed") {
        body.set(
            "failure",
            driverJson.createObjectNode().put("reasonCode", payload.path("reasonCode").asString()).put("note", note),
        )
    }
}

private fun items(source: JsonNode): JsonNode = driverJson.createArrayNode().apply {
    source.forEach { item ->
        add(driverJson.createObjectNode().put("sku", item.path("sku").asString()).apply {
            set("orderedQty", item.path("orderedQty"))
            set("deliveredQty", item.path("deliveredQty"))
        })
    }
}
