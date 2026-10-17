package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.EtaStopInput
import com.evnsolution.meatbox.eta.insideGeometry
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboundDraft
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime

/** A recomputed `etas[vehicleId]` and whether Meatbox is owed a new ETA message for it. */
internal class Recomputed(val node: ObjectNode, val notify: Boolean)

/**
 * Recomputes the ETA of the stops still open after an event, from [anchor] at [origin]: the shared step of every
 * trigger after the departure. [previous] is the vehicle's stored ETA. Stops that are no longer open keep their old
 * entry as history; [closed], the stop this event closed, gets `actualAt = anchor`. `sequence` is the stop's position
 * in the whole route. Meatbox is owed a message when [always] is set, or when an open stop's new ETA differs from
 * the one last sent (`reported`) by the configured threshold or more; `reported` moves only when a message is owed.
 */
@Suppress("LongParameterList")
internal fun recomputeRemaining(
    previous: JsonNode,
    after: Route,
    anchor: Instant,
    origin: EtaPoint?,
    reason: String,
    receivedAt: String,
    context: EtaContext,
    closed: String?,
    always: Boolean,
): Recomputed {
    val open = after.stops.withIndex().filter { it.value.status in OPEN }
    val inputs = open.map { EtaStopInput(it.value.stopId, stopPoint(it.value)) }
    val computed = context.model.compute(inputs, anchor, origin)
    val openIds = open.map { it.value.stopId }.toSet()
    val routeIds = after.stops.map { it.stopId }.toSet()
    val stops = driverJson.createArrayNode()
    previous.path("stops").filter { it.path("stopId").asString() in routeIds - openIds }.forEach { old ->
        val entry = (old.deepCopy() as ObjectNode)
        if (old.path("stopId").asString() == closed && !entry.has("actualAt")) entry.put("actualAt", stampOf(anchor))
        stops.add(entry)
    }
    computed.forEachIndexed { index, stop ->
        stops.add(stopNode(stop.stopId, open[index].index + 1, stop.eta, stop.estimated))
    }
    val fresh = reportedOf(stops)
    val sent = previous.path("reported").associate { it.path("stopId").asString() to it.path("eta").asString() }
    val limit = Duration.ofMinutes(context.model.config.delayThresholdMinutes.toLong())
    val moved = fresh.any { entry ->
        val before = sent[entry.path("stopId").asString()]?.let(OffsetDateTime::parse)
        before == null || Duration.between(before, OffsetDateTime.parse(entry.path("eta").asString())).abs() >= limit
    }
    val notify = fresh.size() > 0 && (always || moved)
    val node = driverJson.createObjectNode().apply {
        put("computedAt", receivedAt)
        put("reason", reason)
        previous.get("departedAt")?.let { set("departedAt", it) }
        previous.get("departureTimeSource")?.let { set("departureTimeSource", it) }
        put("recomputes", previous.path("recomputes").asInt(0) + 1)
        context.model.engine(inputs, origin)?.let { put("engine", it) }
        set("stops", stops)
        set("reported", if (notify) fresh else previous.path("reported").deepCopy())
    }
    return Recomputed(node, notify)
}

/**
 * Why a stop closing at [anchor] recomputes: `delayed` when it closed `threshold` or more away from when it was due
 * to close (late or early), else `completed`. A stop is due to close its work time after the ETA it had; a stop
 * without a stored ETA counts as on time.
 */
internal fun completionReason(previous: JsonNode, stopId: String, anchor: Instant, config: EtaConfig): String {
    val arrival = previous.path("stops").firstOrNull { it.path("stopId").asString() == stopId }?.path("eta")
        ?.asString("")?.takeIf(String::isNotEmpty) ?: return "completed"
    val due = OffsetDateTime.parse(arrival).toInstant().plusSeconds(config.serviceMinutes * SECONDS_PER_MINUTE)
    val off = Duration.between(due, anchor).abs()
    return if (off >= Duration.ofMinutes(config.delayThresholdMinutes.toLong())) "delayed" else "completed"
}

private const val SECONDS_PER_MINUTE = 60L

private val CLOSING = setOf("stop_completed", "stop_failed", "stop_partially_completed")

/**
 * What one event does to its vehicle's ETA, across the two steps of a batch ([etas] first, then [messages]). The
 * departure sets it. A stop closing, a zone entry and a reorder after the departure recompute it when the vehicle has
 * a stored ETA, which is when the departure came from the driver app; other vehicles have nothing to follow.
 */
internal class EtaEffect(
    private val event: DriverEvent,
    private val receivedAt: String,
    private val context: EtaContext,
    private val previous: JsonNode,
    private val handled: RouteStop?,
) {
    private var result: Recomputed? = null

    fun etas(after: Route): Map<String, ObjectNode> {
        val stored = previous.path("stops").isArray
        result = when {
            event.type == "departed" -> Recomputed(etaOf(event, receivedAt, context, after), true)
            stored && event.type in CLOSING -> afterClosing(after, handled!!)
            stored && event.type == "zone_entered" -> from("zone_entered", eventPoint(event), always = false, after)
            stored && event.type == "route_reordered" ->
                from("reordered", eventPoint(event) ?: context.sampledOrigin, always = true, after)
            else -> null
        }
        return result?.let { mapOf(event.vehicleId to it.node) } ?: emptyMap()
    }

    /** The ETA message owed for the stored ETA, or none when the stops left need no new message. */
    fun messages(after: Route): List<OutboundDraft> =
        if (result?.notify == true) etaMessages(event, after) else emptyList()

    private fun from(reason: String, origin: EtaPoint?, always: Boolean, after: Route): Recomputed =
        recomputeRemaining(
            previous, after, eventTime(event, receivedAt).instant, origin, reason, receivedAt, context,
            closed = null, always = always,
        )

    /**
     * The stops left are timed from the moment the stop closed, starting at the position the event reports, else
     * the closed stop's own position. The stop's work is over then, so no work time is added before the first leg.
     */
    private fun afterClosing(after: Route, closed: RouteStop): Recomputed {
        val anchor = eventTime(event, receivedAt).instant
        val reason = completionReason(previous, closed.stopId, anchor, context.model.config)
        return recomputeRemaining(
            previous, after, anchor, eventPoint(event) ?: stopPoint(closed), reason, receivedAt, context,
            closed = closed.stopId, always = false,
        )
    }
}

/**
 * A zone entry needs a position once the vehicle has a stored ETA to follow (`400 LOCATION_REQUIRED`), and a position
 * outside the zone's polygon is `422 ZONE_MISMATCH`. A zone the installation has no polygon for is only recorded.
 */
internal fun checkZone(event: DriverEvent, stored: JsonNode, regions: JsonNode?) {
    val where = eventPoint(event)
    if (where == null) {
        if (stored.path("stops").isArray) driverFail(HttpStatus.BAD_REQUEST.value(), "LOCATION_REQUIRED")
        return
    }
    val zoneId = event.payload.path("zoneId").asString()
    val geometry = regions?.path("features")?.firstOrNull { it.path("properties").path("zoneId").asString() == zoneId }
        ?.path("geometry")
    val known = geometry?.path("type")?.asString("") in setOf("Polygon", "MultiPolygon")
    if (known && !insideGeometry(geometry!!, where)) {
        driverFail(HttpStatus.UNPROCESSABLE_ENTITY.value(), "ZONE_MISMATCH")
    }
}
