package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.CommandBatch
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode

/** One stop of a vehicle route: the destination bundle that the operational engine moves as a unit. */
internal class RouteStop(val stopId: String, val unitId: String, val status: String, val deliveries: List<JsonNode>) {
    val orderIds: List<String> get() = deliveries.map { it.path("id").asString() }
}

/** The stops, phase and truck of one vehicle, read from a date snapshot. */
internal class Route(val snapshot: ObjectNode, val vehicleId: String) {
    private val state = snapshot.path("vehicleStates").path(vehicleId)
    val phase: String = state.path("phase").asString("idle")
    val revision: Long = snapshot.path("revision").asLong()

    /** The vehicle's stored ETA (`vehicleStates[v].eta`), or a missing node before it has departed. */
    val eta: JsonNode = state.path("eta")
    val stops: List<RouteStop> = snapshot.path("fleetDeliveries")
        .filter { it.path("vehicleId").asString() == vehicleId }
        .groupBy { it.path("assignmentUnitId").asString() }
        .map { (unit, group) ->
            RouteStop(group.first().path("id").asString(), unit, group.first().path("status").asString(), group)
        }

    /** The stop that holds this order ID, or 404 when it is not on this vehicle's route. */
    fun stop(id: String): RouteStop =
        stops.firstOrNull { id in it.orderIds } ?: driverFail(HttpStatus.NOT_FOUND.value(), "STOP_NOT_FOUND")

    /** The stored ETA entry of one stop, or null when the vehicle has none for it. */
    fun etaOf(stopId: String): JsonNode? = eta.path("stops").firstOrNull { it.path("stopId").asString() == stopId }

    fun next(except: String?): RouteStop? =
        stops.firstOrNull { it.stopId != except && it.status in setOf("current", "pending") }

    fun arrivedAt(stop: RouteStop): Boolean {
        val truck = state.path("truck")
        return truck.path("atStopId").asString("") == stop.stopId && truck.path("dwelling").asBoolean(false)
    }

    /** A full `set_route_order` for stops listed in the new order, or null when the order does not change. */
    fun reorder(requested: List<String>, always: Boolean): ObjectNode? {
        val ordered = requested.map(::stop)
        if (ordered.size != stops.size || ordered.map { it.stopId }.toSet().size != stops.size) invalidInput()
        if (!always && ordered.map { it.stopId } == stops.map { it.stopId }) return null
        val all = stops.flatMap { it.deliveries }
        return operation("set_route_order", vehicleId).apply {
            set("order", strings(ordered.flatMap { it.orderIds }))
            set("expectedOrder", strings(all.map { it.path("id").asString() }))
            set("expectedStatuses", strings(all.map { it.path("status").asString() }))
            put("expectedPhase", phase)
        }
    }
}

private fun strings(values: List<String>): ArrayNode = driverJson.createArrayNode().apply { values.forEach(::add) }

private fun operation(type: String, vehicleId: String): ObjectNode =
    driverJson.createObjectNode().put("type", type).put("vehicleId", vehicleId)

/**
 * Translates one event into the existing operational commands. The route comes from the snapshot taken inside the
 * dispatch lock, so the commands' own consistency checks pass and `expectedRevision` is the only stale-view guard.
 */
internal fun planEvent(
    event: DriverEvent,
    receivedAt: String,
    photoBase: String,
    eta: EtaContext,
): (ObjectNode) -> CommandBatch = { snapshot ->
    // A date that turned read-only after the first send still answers from its stored result.
    // Only new events stop here.
    if (snapshot.path("dispatch").path("readOnly").asBoolean(true)) {
        driverFail(HttpStatus.CONFLICT.value(), "DRIVER_DATE_READ_ONLY")
    }
    val route = Route(snapshot, event.vehicleId)
    val handled = if (event.type.startsWith("stop_")) route.stop(event.payload.path("stopId").asString()) else null
    val steps = when (event.type) {
        "departed" -> departedSteps(route, event.payload)
        "zone_entered" -> emptyList<ObjectNode>().also { checkZone(event, route.eta, eta.regions) }
        "route_reordered" -> listOf(reorderedStep(route, event.payload))
        else -> stopSteps(route, event, handled!!)
    }
    val effect = EtaEffect(event, receivedAt, eta, route.eta, handled)
    CommandBatch(
        steps,
        outbound = { after ->
            val shown = Route(after, event.vehicleId)
            deliveryMessages(event, handled, shown, photoBase) + effect.messages(shown)
        },
        etas = { after -> effect.etas(Route(after, event.vehicleId)) },
    ) { after -> reply(Route(after, event.vehicleId), handled?.stopId, receivedAt) }
}

private fun departedSteps(route: Route, payload: ObjectNode): List<ObjectNode> = listOfNotNull(
    payload.get("stopOrder")?.let { route.reorder(it.toList().map(JsonNode::asString), always = false) },
    operation("start_route", route.vehicleId),
)

/**
 * Before the departure any order is allowed. After it, only the stops still pending may change places: a stop that
 * is current, done or skipped holds its position, and a finished route holds all of them (`ROUTE_LOCKED`).
 */
private fun reorderedStep(route: Route, payload: ObjectNode): ObjectNode {
    if (route.phase == "done") driverFail(HttpStatus.CONFLICT.value(), "ROUTE_LOCKED")
    val expected = payload.get("expectedRevision")
    if (expected != null && expected.longValue() != route.revision) {
        driverFail(HttpStatus.CONFLICT.value(), "REVISION_CONFLICT")
    }
    val requested = payload.path("stopOrder").toList().map(JsonNode::asString)
    if (route.phase == "delivering" && movesClosedStop(route, requested)) {
        driverFail(HttpStatus.CONFLICT.value(), "ROUTE_LOCKED")
    }
    return route.reorder(requested, always = true)!!
}

private fun movesClosedStop(route: Route, requested: List<String>): Boolean {
    val ordered = requested.map { route.stop(it).stopId }
    return ordered.size == route.stops.size &&
        route.stops.withIndex().any { (index, stop) -> stop.status != "pending" && ordered[index] != stop.stopId }
}

/** Arrive if the truck has not, then close the stop: `complete_stop`, or `skip_stop` for a failed delivery. */
private fun stopSteps(route: Route, event: DriverEvent, stop: RouteStop): List<ObjectNode> {
    val named = listOf("orderIds", "orderId").flatMap { key ->
        when (val value = event.payload.get(key)) {
            null -> emptyList()
            is ArrayNode -> value.toList().map(JsonNode::asString)
            else -> listOf(value.asString())
        }
    }
    if (!stop.orderIds.containsAll(named)) invalidInput()
    val closing = if (event.type == "stop_failed") "skip_stop" else "complete_stop"
    return listOfNotNull(
        if (route.arrivedAt(stop)) null else operation("arrive_stop", route.vehicleId).put("orderId", stop.stopId),
        operation(closing, route.vehicleId).put("orderId", stop.stopId),
    )
}

private fun reply(after: Route, handled: String?, receivedAt: String): ObjectNode =
    driverJson.createObjectNode().apply {
    put("accepted", true)
    put("duplicate", false)
    put("receivedAt", receivedAt)
    handled?.let { id ->
        val status = after.stops.first { it.stopId == id }.status
        set("stop", driverJson.createObjectNode().put("stopId", id).put("status", status))
    }
    after.next(handled)?.let { set("next", nextStop(it.stopId, after)) }
}

/** `{stopId, eta}` of the next stop; `eta` is null until the vehicle has departed. */
internal fun nextStop(stopId: String, route: Route): ObjectNode = driverJson.createObjectNode().put("stopId", stopId)
    .set("eta", route.etaOf(stopId)?.path("eta") ?: driverJson.nullNode())
