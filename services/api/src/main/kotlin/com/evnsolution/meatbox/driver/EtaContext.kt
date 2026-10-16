package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DriverLocations
import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaModel
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.EtaStopInput
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboundDraft
import com.evnsolution.meatbox.integrations.meatbox.outbound.etaBody
import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import kotlin.math.abs

/** What an ETA needs besides the route: the model and the newest reported position, used when the event has none. */
internal class EtaContext(val model: EtaModel, val sampledOrigin: EtaPoint?)

/** A device clock further than this from the server's is not trusted for the departure time. */
internal const val MAX_CLOCK_SKEW_MILLIS = 5 * 60 * 1000L

internal val OPEN = setOf("current", "pending")

/** The instant an event happened and whether the device clock was trusted for it. */
internal class EventTime(val instant: Instant, val trusted: Boolean)

/** The device's `occurredAt` unless it differs from [receivedAt] by more than [MAX_CLOCK_SKEW_MILLIS]. */
internal fun eventTime(event: DriverEvent, receivedAt: String): EventTime {
    val received = OffsetDateTime.parse(receivedAt).toInstant()
    val device = OffsetDateTime.parse(event.body.path("occurredAt").asString()).toInstant()
    val trusted = abs(device.toEpochMilli() - received.toEpochMilli()) <= MAX_CLOCK_SKEW_MILLIS
    return EventTime(if (trusted) device else received, trusted)
}

internal fun stampOf(instant: Instant): String = seoulStamp(instant.toEpochMilli())

/**
 * The ETA that a `departed` event sets for its vehicle: the stored shape of `etas[vehicleId]`. [after] is the route
 * the departure left. The departure time is [eventTime]; `departureTimeSource` says which clock was used. The origin
 * is the event's `location`, else the newest reported position, else none (the first stop then adds no travel time).
 * `reported` is what Meatbox is told with it, and `recomputes` counts the later [recomputeRemaining] calls.
 */
internal fun etaOf(event: DriverEvent, receivedAt: String, context: EtaContext, after: Route): ObjectNode {
    val time = eventTime(event, receivedAt)
    val origin = point(event.body.path("location"), "lat", "lng") ?: context.sampledOrigin
    val open = after.stops.filter { it.status in OPEN }
    val computed = context.model.compute(open.map { EtaStopInput(it.stopId, stopPoint(it)) }, time.instant, origin)
    val stops = driverJson.createArrayNode().apply {
        computed.forEach { add(stopNode(it.stopId, it.sequence, it.eta, it.estimated)) }
    }
    return driverJson.createObjectNode().apply {
        put("computedAt", receivedAt)
        put("reason", "departed")
        put("departedAt", stampOf(time.instant))
        put("departureTimeSource", if (time.trusted) "device" else "server")
        put("recomputes", 0)
        set("stops", stops)
        set("reported", reportedOf(stops))
    }
}

internal fun stopNode(stopId: String, sequence: Int, eta: Instant, estimated: Boolean): ObjectNode =
    driverJson.createObjectNode().put("stopId", stopId).put("sequence", sequence)
        .put("eta", stampOf(eta)).put("estimated", estimated)

internal fun reportedOf(stops: JsonNode) = driverJson.createArrayNode().apply {
    stops.filter { !it.has("actualAt") }.forEach {
        val entry = driverJson.createObjectNode().put("stopId", it.path("stopId").asString())
        add(entry.put("eta", it.path("eta").asString()))
    }
}

/** The position an event reports (`location.lat/lng`), or null. */
internal fun eventPoint(event: DriverEvent): EtaPoint? = point(event.body.path("location"), "lat", "lng")

/** The stop's first order that has usable coordinates (`[lng, lat]`); a bundle shares one destination. */
internal fun stopPoint(stop: RouteStop): EtaPoint? = stop.deliveries.firstNotNullOfOrNull { delivery ->
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
 * The ETA message of contract 3.2 for the stored ETA that [after] carries: one entry per open stop with the stop's
 * orders (history entries with `actualAt` are not told). The message is per vehicle and carries the whole list, so
 * the draft is keyed `eta-{vehicleId}`; a recomputation adds `-r{n}` to its id because it can share the engine
 * revision of the message before it. An unsent older message is replaced when this one is filed.
 */
internal fun etaMessages(event: DriverEvent, after: Route): List<OutboundDraft> {
    val eta = after.eta
    val open = eta.path("stops").filter { !it.has("actualAt") }
    if (open.isEmpty()) return emptyList()
    val stops = driverJson.createArrayNode().apply {
        open.forEach { stop ->
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
    val recomputes = eta.path("recomputes").asInt(0)
    return listOf(OutboundDraft("eta", "eta-${event.vehicleId}", body, if (recomputes > 0) "-r$recomputes" else ""))
}
