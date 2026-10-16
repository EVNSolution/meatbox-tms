package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.DispatchException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit

internal val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
internal val TELEMETRY_ID = Regex("[A-Za-z0-9._-]{1,64}")
private const val BAD_REQUEST = 400
private const val MIN_CELSIUS = -60.0
private const val MAX_CELSIUS = 60.0
private const val MAX_READINGS = 500
private val MAX_FUTURE: Duration = Duration.ofMinutes(5)
private val MAX_AGE: Duration = Duration.ofDays(7)
private val COMPARTMENTS = setOf("frozen", "chilled")

internal fun telemetryFail(status: Int, code: String): Nothing = throw DispatchException(status, code, code)

/** One measurement. [receivedAtMillis] is only known for lines read back from a file. */
data class Reading(
    val sensorId: String,
    val measuredAt: Instant,
    val celsius: Double,
    val compartment: String?,
    val receivedAtMillis: Long = 0,
)

/** What one ingest request carries: one sensor of one vehicle. */
class Batch(val vehicleId: String, val sensorId: String, val readings: List<Reading>)

internal fun validVehicleId(value: String): Boolean = TELEMETRY_ID.matches(value) && value != "latest"

/** Checks the whole request before anything is stored: one wrong measurement rejects all of them. */
internal fun parseBatch(body: ObjectNode, now: Instant): Batch {
    if (body.properties().any { it.key !in setOf("vehicleId", "sensorId", "measurements") }) invalid()
    val vehicleId = text(body, "vehicleId")
    val sensorId = text(body, "sensorId")
    if (!validVehicleId(vehicleId) || !TELEMETRY_ID.matches(sensorId)) invalid()
    val items = body.path("measurements")
    if (!items.isArray || items.isEmpty || items.size() > MAX_READINGS) invalid()
    return Batch(vehicleId, sensorId, items.toList().map { reading(it, sensorId, now) })
}

private fun reading(item: JsonNode, sensorId: String, now: Instant): Reading {
    val fields = item as? ObjectNode ?: invalid()
    if (fields.properties().any { it.key !in setOf("measuredAt", "celsius", "compartment") }) invalid()
    val measuredAt = runCatching {
        OffsetDateTime.parse(text(fields, "measuredAt")).toInstant().truncatedTo(ChronoUnit.SECONDS)
    }.getOrNull() ?: invalid()
    if (measuredAt.isAfter(now.plus(MAX_FUTURE))) telemetryFail(BAD_REQUEST, "MEASURED_AT_FUTURE")
    if (measuredAt.isBefore(now.minus(MAX_AGE))) telemetryFail(BAD_REQUEST, "MEASURED_AT_TOO_OLD")
    val celsius = fields.path("celsius")
    if (!celsius.isNumber || !celsius.doubleValue().isFinite()) invalid()
    if (celsius.doubleValue() !in MIN_CELSIUS..MAX_CELSIUS) telemetryFail(BAD_REQUEST, "TEMPERATURE_OUT_OF_BOUNDS")
    val compartment = fields.get("compartment")?.let { if (it.isString) it.asString() else invalid() }
    if (compartment != null && compartment !in COMPARTMENTS) invalid()
    return Reading(sensorId, measuredAt, celsius.doubleValue(), compartment)
}

private fun text(node: JsonNode, key: String): String = node.path(key).takeIf { it.isString }?.asString() ?: invalid()

private fun invalid(): Nothing = telemetryFail(BAD_REQUEST, "INVALID_TELEMETRY")
