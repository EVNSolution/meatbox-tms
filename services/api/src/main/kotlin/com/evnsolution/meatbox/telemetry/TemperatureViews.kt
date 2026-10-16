package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.time.Duration
import java.time.Instant

private const val MAX_RAW = 5000
private const val SECONDS_PER_MINUTE = 60L
private const val MILLIS = 1000L
private const val TENTH = 10.0
internal val MAX_RANGE: Duration = Duration.ofHours(24)

internal fun stamp(instant: Instant): String = seoulStamp(instant.toEpochMilli())

/** Every sensor's newest value with its age and whether the service has heard from it recently. */
internal fun latestView(store: TemperatureStore, watch: TemperatureWatch): ObjectNode {
    val now = store.now()
    val rows: ArrayNode = telemetryJson.createArrayNode()
    store.latest().forEach { latest ->
        val row = rows.addObject().put("vehicleId", latest.vehicleId).put("sensorId", latest.sensorId)
            .put("celsius", latest.celsius).put("measuredAt", stamp(latest.measuredAt))
            .put("receivedAt", stamp(latest.receivedAt))
            .put("ageSeconds", Duration.between(latest.receivedAt, now).seconds.coerceAtLeast(0))
            .put("stale", store.stale(latest)).put("outOfRange", watch.outOfRange(latest))
        latest.compartment?.let { row.put("compartment", it) }
        val range = watch.rangeOf(latest)
        if (range == null) row.putNull("range") else {
            row.putObject("range").put("min", range.min).put("max", range.max)
        }
    }
    return telemetryJson.createObjectNode().put("generatedAt", stamp(now)).set("vehicles", rows)
}

/** `raw` lists up to [MAX_RAW] measurements; `1m` folds each sensor's measurements into one row per minute. */
internal fun historyView(
    vehicleId: String,
    readings: List<Reading>,
    from: Instant,
    to: Instant,
    perMinute: Boolean,
): ObjectNode {
    val view = telemetryJson.createObjectNode().put("vehicleId", vehicleId).put("from", stamp(from))
        .put("to", stamp(to)).put("resolution", if (perMinute) "1m" else "raw")
    val rows = view.putArray("measurements")
    if (perMinute) minutes(readings).forEach(rows::add) else readings.take(MAX_RAW).forEach { rows.add(raw(it)) }
    return view.put("truncated", !perMinute && readings.size > MAX_RAW)
}

private fun raw(reading: Reading): ObjectNode {
    val row = telemetryJson.createObjectNode().put("sensorId", reading.sensorId)
        .put("measuredAt", stamp(reading.measuredAt)).put("celsius", reading.celsius)
    reading.compartment?.let { row.put("compartment", it) }
    return row
}

private fun minutes(readings: List<Reading>): List<ObjectNode> =
    readings.groupBy { it.sensorId to it.measuredAt.epochSecond / SECONDS_PER_MINUTE }.map { (key, group) ->
        telemetryJson.createObjectNode().put("sensorId", key.first)
            .put("measuredAt", seoulStamp(key.second * SECONDS_PER_MINUTE * MILLIS))
            .put("celsius", tenth(group.map { it.celsius }.average()))
            .put("min", group.minOf { it.celsius }).put("max", group.maxOf { it.celsius }).put("count", group.size)
    }

private fun tenth(value: Double): Double = Math.round(value * TENTH) / TENTH
