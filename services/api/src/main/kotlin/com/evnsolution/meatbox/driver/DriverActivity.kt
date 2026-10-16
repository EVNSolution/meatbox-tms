package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DriverLocationSource
import com.evnsolution.meatbox.dispatch.DriverLocations
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap

private const val MAX_SAMPLES = 120

/** Events whose ETA may start from the newest reported position when the event itself has none. */
private val SAMPLED = setOf("departed", "route_reordered")
private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")

/**
 * What the driver app sends: events (translated into operational commands under the event id), location batches and
 * photos. It runs under the driver store's lock, file lock and date checks.
 */
class DriverActivity internal constructor(private val store: DriverStore) {
    private val photos = DriverPhotos(store.directory)
    private val reported = ConcurrentHashMap<String, DriverLocations>()

    init {
        // The date snapshot reads positions through this callback, so it must never wait for the store lock.
        store.dispatch.locations = DriverLocationSource(::latestLocations)
    }

    class Reply(val body: ObjectNode, val duplicate: Boolean)

    fun acceptEvent(date: String, body: ObjectNode): Reply = synchronized(store) {
        val event = parseEvent(body, date)
        store.validate(date, event.vehicleId)
        if (!event.photoIds.all { photos.exists(date, it) }) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "PHOTO_NOT_FOUND")
        }
        val sampled = if (event.type in SAMPLED) sampledPoint(latestLocations(date), event.vehicleId) else null
        val regions = if (event.type == "zone_entered") store.dispatch.regions() else null
        val plan = planEvent(
            event, stamp(store.clock()), photoBase(store.publicOrigin, date),
            EtaContext(store.eta, sampled, regions),
        )
        val result = store.dispatch.batch(date, event.eventId, body, plan)
        record(date, event, result.response)
        Reply(result.response.put("duplicate", result.replayed), result.replayed)
    }

    fun eventResult(date: String, eventId: String): ObjectNode {
        if (!validEventId(eventId)) invalidInput()
        val stored = store.dispatch.result(date, eventId)
        if (!stored.has("accepted")) driverFail(HttpStatus.NOT_FOUND.value(), "REQUEST_NOT_FOUND")
        return stored.put("duplicate", true)
    }

    /** Writes the event record once, after the commands succeeded. A resend after a failed write fills the gap. */
    private fun record(date: String, event: DriverEvent, response: ObjectNode) {
        val stop = response.path("stop").path("stopId").asString("").takeIf(String::isNotEmpty)
            ?.let { id -> Route(store.dispatch.snapshot(date), event.vehicleId).stops.first { it.stopId == id } }
        val record = driverJson.createObjectNode().put("eventId", event.eventId).put("type", event.type)
            .put("vehicleId", event.vehicleId).put("occurredAt", event.body.path("occurredAt").asString())
            .put("receivedAt", response.path("receivedAt").asString())
        event.body.get("location")?.let { record.set("location", it.deepCopy()) }
        event.payload.properties().filter { it.key !in setOf("stopId", "orderId", "orderIds") }
            .forEach { (key, value) -> record.set(key, value.deepCopy()) }
        if (stop != null) {
            record.put("stopId", stop.stopId).put("assignmentUnitId", stop.unitId)
            record.set("orderIds", driverJson.createArrayNode().apply { stop.orderIds.forEach(::add) })
        }
        store.mutate {
            val state = store.load(date)
            val events = state.path("events") as ArrayNode
            if (events.none { it.path("eventId").asString() == event.eventId }) {
                events.add(record)
                // Oldest first, so a late write never fails an event that is already applied.
                while (events.size() > DriverStore.MAX_EVENTS ||
                    (events.size() > 1 && driverJson.writeValueAsBytes(state).size > DriverStore.MAX_FILE_BYTES)
                ) events.remove(0)
                store.save(date, state)
            }
        }
    }

    /** Merges a location batch. A resent sample (same instant) replaces itself, so retries do not grow the list. */
    fun acceptLocations(date: String, vehicleId: String, samples: ArrayNode): ObjectNode = synchronized(store) {
        store.validate(date, vehicleId, writable = true)
        store.mutate {
            val state = store.load(date)
            val all = state.path("locations") as ObjectNode
            val merged = linkedMapOf<Instant, JsonNode>()
            (all.path(vehicleId) as? ArrayNode)?.forEach { merged[instant(it)] = it }
            samples.forEach { merged[instant(it)] = it.deepCopy() }
            val kept = merged.entries.sortedBy { it.key }.takeLast(MAX_SAMPLES)
            all.set(vehicleId, driverJson.createArrayNode().apply { kept.forEach { add(it.value) } })
            state.put("locationVersion", state.path("locationVersion").asLong() + 1)
            store.save(date, state)
            reported[date] = latest(state)
            driverJson.createObjectNode().put("accepted", samples.size()).put("retained", kept.size)
                .put("receivedAt", stamp(store.clock()))
        }
    }

    private fun latestLocations(date: String): DriverLocations = reported[date]
        ?: runCatching { latest(store.load(date)) }.getOrElse { DriverLocations(0, emptyMap()) }
            .also { reported[date] = it }

    private fun latest(state: ObjectNode): DriverLocations {
        val byVehicle = state.path("locations").properties().mapNotNull { (id, samples) ->
            samples.maxByOrNull(::instant)?.let { id to vehicleLocation(it) }
        }.toMap()
        return DriverLocations(state.path("locationVersion").asLong(), byVehicle)
    }

    private fun vehicleLocation(sample: JsonNode): ObjectNode = driverJson.createObjectNode().apply {
        val lng = sample.path("lng").doubleValue()
        set("coordinates", driverJson.createArrayNode().add(lng).add(sample.path("lat").doubleValue()))
        put("label", "기사 앱 위치")
        put("source", "driver")
        put("at", sample.path("at").asString())
        sample.get("accuracyM")?.let { set("accuracyM", it.deepCopy()) }
    }

    fun savePhoto(date: String, bytes: ByteArray): ObjectNode {
        store.validate(date, writable = true)
        val (id, size) = photos.save(date, bytes)
        return driverJson.createObjectNode().put("photoId", id).put("bytes", size)
    }

    internal fun readPhoto(date: String, photoId: String): StoredPhoto = photos.read(date, photoId)

    private fun instant(sample: JsonNode): Instant = OffsetDateTime.parse(sample.path("at").asString()).toInstant()

    private fun stamp(at: Instant): String =
        at.atZone(SEOUL).truncatedTo(ChronoUnit.SECONDS).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}
