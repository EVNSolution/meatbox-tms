package com.evnsolution.meatbox.export

import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode

internal val exportJson: JsonMapper = JsonMapper.builder().build()

private val ORDER_FIELDS = listOf("name", "address", "boxes", "status", "arrivedAt", "completedAt")
private val EVENT_FIELDS = listOf("eventId", "type", "occurredAt", "reasonCode", "note", "photoIds")

/**
 * A reading aid for one date, derived from the date's snapshot and the driver events: per vehicle its route in order,
 * with each stop's status, times, reason and photos. It adds no information that the raw files lack.
 */
internal fun summarize(date: String, snapshot: ObjectNode, events: List<JsonNode>): ObjectNode {
    val closing = events.filter { it.path("type").asString().startsWith("stop_") }
        .flatMap { event -> event.path("orderIds").toList().map { it.asString() to event } }
        .toMap()
    val stops = snapshot.path("fleetDeliveries").toList().groupBy { it.path("vehicleId").asString() }
    return exportJson.createObjectNode().apply {
        put("date", date)
        put("revision", snapshot.path("revision").asLong())
        put("phase", snapshot.path("dispatch").path("phase").asString(""))
        put("sourceId", snapshot.path("sourceData").path("sourceId").asString(""))
        val vehicles = putArray("vehicles")
        snapshot.path("fleetVehicles").forEach { vehicle ->
            val id = vehicle.path("id").asString()
            vehicles.addObject().apply {
                put("vehicleId", id)
                put("plate", vehicle.path("plate").asString(""))
                put("driver", vehicle.path("driver").asString(""))
                val eta = snapshot.path("vehicleStates").path(id).path("eta")
                put("etaComputedAt", eta.path("computedAt").asString(""))
                val etas = eta.path("stops").toList()
                    .associate { it.path("stopId").asString() to it.path("eta").asString() }
                val list = putArray("stops")
                stops[id].orEmpty().forEach { list.add(stop(it, etas, closing[it.path("id").asString()])) }
            }
        }
    }
}

private fun stop(order: JsonNode, etas: Map<String, String>, event: JsonNode?): ObjectNode =
    exportJson.createObjectNode().apply {
        val id = order.path("id").asString()
        put("sequence", order.path("sequence").asInt())
        put("orderId", id)
        ORDER_FIELDS.forEach { field -> order.get(field)?.takeUnless(JsonNode::isNull)?.let { set(field, it) } }
        etas[id]?.let { put("eta", it) }
        event?.let { e -> set("closedBy", exportJson.createObjectNode().also { out ->
            EVENT_FIELDS.forEach { field -> e.get(field)?.let { out.set(field, it) } }
        }) }
    }
