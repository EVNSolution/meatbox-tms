package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DriverLocations
import com.evnsolution.meatbox.eta.EtaModel
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.EtaStopInput
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboundDraft
import com.evnsolution.meatbox.integrations.meatbox.outbound.etaBody
import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.OffsetDateTime
import kotlin.math.abs

/** What an ETA needs besides the route: the model and the newest reported position, used when the event has none. */
internal class EtaContext(val model: EtaModel, val sampledOrigin: EtaPoint?)

/** A device clock further than this from the server's is not trusted for the departure time. */
internal const val MAX_CLOCK_SKEW_MILLIS = 5 * 60 * 1000L

private val OPEN = setOf("current", "pending")

/**
 * The ETA that a `departed` event sets for its vehicle: the stored shape of `etas[vehicleId]`. [after] is the route
 * the departure left. The departure time is the device's `occurredAt` unless it differs from [receivedAt] by more than
 * [MAX_CLOCK_SKEW_MILLIS]; `departureTimeSource` says which one was used. The origin is the event's `location`, else
 * the newest reported position, else none (the first stop then adds no travel time). Re-estimates call this with
 * another [reason].
 */
internal fun etaOf(
    event: DriverEvent,
    receivedAt: String,
    context: EtaContext,
    after: Route,
    reason: String,
): ObjectNode {
    val received = OffsetDateTime.parse(receivedAt).toInstant()
    val device = OffsetDateTime.parse(event.body.path("occurredAt").asString()).toInstant()
    val trusted = abs(device.toEpochMilli() - received.toEpochMilli()) <= MAX_CLOCK_SKEW_MILLIS
    val departure = if (trusted) device else received
    val origin = point(event.body.path("location"), "lat", "lng") ?: context.sampledOrigin
    val inputs = after.stops.filter { it.status in OPEN }.map { EtaStopInput(it.stopId, stopPoint(it)) }
    return driverJson.createObjectNode().apply {
        put("computedAt", receivedAt)
        put("reason", reason)
        put("departedAt", seoulStamp(departure.toEpochMilli()))
        put("departureTimeSource", if (trusted) "device" else "server")
        set("stops", driverJson.createArrayNode().apply {
            context.model.compute(inputs, departure, origin).forEach { stop ->
                add(
                    driverJson.createObjectNode().put("stopId", stop.stopId).put("sequence", stop.sequence)
                        .put("eta", seoulStamp(stop.eta.toEpochMilli())).put("estimated", stop.estimated),
                )
            }
        })
    }
}

/** The stop's first order that has usable coordinates (`[lng, lat]`); a bundle shares one destination. */
private fun stopPoint(stop: RouteStop): EtaPoint? = stop.deliveries.firstNotNullOfOrNull { delivery ->
    val coordinates = delivery.path("coordinates")
    if (coordinates.size() == 2) point(coordinates[1], coordinates[0]) else null
}

private fun point(location: JsonNode, latKey: String, lngKey: String): EtaPoint? =
    point(location.path(latKey), location.path(lngKey))

private fun point(lat: JsonNode, lng: JsonNode): EtaPoint? {
    val valid = lat.isNumber && lng.isNumber &&
        lat.doubleValue() in -MAX_LAT..MAX_LAT && lng.doubleValue() in -MAX_LNG..MAX_LNG
    return if (valid) EtaPoint(lat.doubleValue(), lng.doubleValue()) else null
}

/** The vehicle's newest reported position of the day (`coordinates` is `[lng, lat]`), when the app sent one. */
internal fun sampledPoint(reported: DriverLocations, vehicleId: String): EtaPoint? =
    reported.byVehicle[vehicleId]?.path("coordinates")?.let { point(it[1], it[0]) }

private const val MAX_LAT = 90.0
private const val MAX_LNG = 180.0

/**
 * The ETA message of contract 3.2 for the stored ETA that [after] carries: one entry per stop with the stop's orders.
 * The message is per vehicle and carries the whole list, so the draft is keyed `eta-{vehicleId}` and a later one
 * waits for an earlier one.
 */
internal fun etaMessages(event: DriverEvent, after: Route): List<OutboundDraft> {
    val eta = after.eta
    if (!eta.path("stops").isArray) return emptyList()
    val stops = driverJson.createArrayNode().apply {
        eta.path("stops").forEach { stop ->
            val orderIds = after.stops.firstOrNull { it.stopId == stop.path("stopId").asString() }?.orderIds.orEmpty()
            add(
                driverJson.createObjectNode().put("sequence", stop.path("sequence").asInt()).apply {
                    set("orderIds", driverJson.createArrayNode().apply { orderIds.forEach(::add) })
                    set("eta", stop.path("eta"))
                },
            )
        }
    }
    val body = etaBody(event.vehicleId, eta.path("computedAt").asString(), eta.path("reason").asString(), stops)
    return listOf(OutboundDraft("eta", "eta-${event.vehicleId}", body))
}
