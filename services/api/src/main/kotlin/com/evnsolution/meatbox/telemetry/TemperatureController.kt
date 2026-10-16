package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.resources.ResourceStore
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.OffsetDateTime

private const val ACCEPTED = 202
private const val BAD_REQUEST = 400
private const val PAYLOAD_TOO_LARGE = 413
private const val UNSUPPORTED_MEDIA_TYPE = 415
private const val MAX_BODY = 128 * 1024
private val KEY = Regex("[A-Za-z0-9._:-]{1,128}")

/**
 * A terminal or its gateway pushes measurements here with the telemetry Bearer token ([TelemetryTokenFilter]'s job).
 * The route exists only when `MEATBOX_TELEMETRY_TOKEN` is set. A repeat is ignored per measurement, so a resent
 * batch is answered like the first one and needs no stored `Idempotency-Key`.
 */
@RestController
@RequestMapping("/api/telemetry/temperature")
@ConditionalOnExpression("'\${meatbox.dispatch.enabled:false}' == 'true' && '\${meatbox.telemetry.token:}' != ''")
class TemperatureIngestController(
    private val store: TemperatureStore,
    private val alerts: ErrorAlerts,
    private val watch: TemperatureWatch,
    private val resources: ObjectProvider<ResourceStore>,
) {
    private val parser = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()

    @PostMapping
    fun receive(
        @RequestHeader("Idempotency-Key", required = false) key: String?,
        request: HttpServletRequest,
    ): ResponseEntity<ObjectNode> {
        if (key != null && !KEY.matches(key)) telemetryFail(BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY")
        val batch = parseBatch(body(request), store.now())
        val receipt = store.ingest(batch)
        watch.observe(batch.vehicleId, receipt.fresh)
        val unknown = registered(batch.vehicleId) == false
        if (unknown) alerts.report("telemetry", "UNKNOWN_VEHICLE", "vehicleId=${batch.vehicleId}")
        val json = telemetryJson.createObjectNode().put("accepted", receipt.accepted)
            .put("duplicate", receipt.duplicate).put("receivedAt", stamp(store.now())).put("unknownVehicle", unknown)
        return ResponseEntity.status(ACCEPTED).body(json)
    }

    /** True or false when the vehicle register can answer, null when it is off or fails. */
    private fun registered(vehicleId: String): Boolean? = resources.ifAvailable?.let { register ->
        runCatching { register.snapshot().vehicles.any { it.id == vehicleId } }.getOrNull()
    }

    private fun body(request: HttpServletRequest): ObjectNode {
        val isJson = request.contentType?.substringBefore(';')?.trim()?.equals("application/json", true) == true
        if (!isJson) telemetryFail(UNSUPPORTED_MEDIA_TYPE, "INVALID_TELEMETRY")
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = request.inputStream.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_BODY) telemetryFail(PAYLOAD_TOO_LARGE, "TELEMETRY_TOO_LARGE")
            output.write(buffer, 0, count)
        }
        return runCatching { parser.readTree(output.toByteArray()) as? ObjectNode }.getOrNull()
            ?: telemetryFail(BAD_REQUEST, "INVALID_TELEMETRY")
    }
}

/** Operators and apps read the stored values with their login session ([TelemetrySessionFilter]'s job). */
@RestController
@RequestMapping("/api/telemetry/temperature")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class TemperatureQueryController(private val store: TemperatureStore, private val watch: TemperatureWatch) {
    @GetMapping("/latest")
    fun latest(): ObjectNode = latestView(store, watch)

    /** [from]..[to] is at most 24 hours; `to` defaults to now. */
    @GetMapping("/{vehicleId}")
    fun history(
        @PathVariable vehicleId: String,
        @RequestParam from: String,
        @RequestParam(required = false) to: String?,
        @RequestParam(required = false, defaultValue = "raw") resolution: String,
    ): ObjectNode {
        if (!validVehicleId(vehicleId)) telemetryFail(BAD_REQUEST, "INVALID_VEHICLE")
        if (resolution != "raw" && resolution != "1m") telemetryFail(BAD_REQUEST, "INVALID_RESOLUTION")
        val start = instant(from)
        val end = to?.let(::instant) ?: store.now()
        if (!end.isAfter(start) || java.time.Duration.between(start, end) > MAX_RANGE) {
            telemetryFail(BAD_REQUEST, "INVALID_RANGE")
        }
        return historyView(vehicleId, store.readings(vehicleId, start, end), start, end, resolution == "1m")
    }

    private fun instant(value: String): Instant = runCatching { OffsetDateTime.parse(value).toInstant() }
        .getOrElse { throw DispatchException(BAD_REQUEST, "INVALID_RANGE", "INVALID_RANGE") }
}
