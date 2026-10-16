package com.evnsolution.meatbox.driver

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

private const val MAX_PRIOR_FILES = 14
private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
private val PRIOR_FILE = Regex("^driver-(\\d{4}-\\d{2}-\\d{2})\\.json$")
private val STOP_RESULTS = mapOf(
    "stop_completed" to "completed",
    "stop_partially_completed" to "partially_completed",
    "stop_failed" to "failed",
)
private val ORDER_FIELDS = listOf(
    "orderNumber", "name", "address", "detailAddress", "boxes", "items",
    "customerRequests", "tip", "transportConditions", "access", "deliveryType", "csNote",
)
private val SELECTABLE_PHASES = setOf("published", "amending")

/** The driver app's reads. Everything is derived from the date snapshot plus the records the app itself sent. */
@Suppress("TooManyFunctions")
class DriverQueries internal constructor(private val store: DriverStore) {
    /**
     * Stops in order with status, ETA (null before departure), position and orders, the vehicle and whether the day is
     * confirmed, and the `revision` that `route_reordered` expects. This is all the app reads of the day.
     */
    fun route(date: String, vehicleId: String): ObjectNode = synchronized(store) {
        store.validate(date, vehicleId)
        val snapshot = store.dispatch.snapshot(date)
        val route = Route(snapshot, vehicleId)
        val dispatchPhase = snapshot.path("dispatch").path("phase").asString("unplanned")
        driverJson.createObjectNode().apply {
            put("date", date).put("vehicleId", vehicleId).put("revision", route.revision).put("phase", route.phase)
            put("dispatchPhase", dispatchPhase).put("operable", dispatchPhase in SELECTABLE_PHASES)
            set("vehicle", vehicleInfo(snapshot, vehicleId))
            set("stops", array(route.stops.mapIndexed { index, stop ->
                summary(stop, index + 1).also {
                    putEta(it, route, stop)
                    it.set("coordinates", coordinatesOf(stop))
                    it.set("orders", array(stop.deliveries.map(::order)))
                }
            }))
            route.next(null)?.let { set("next", nextStop(it.stopId, route)) }
            if (route.temperature.isObject) set("temperature", route.temperature.deepCopy())
        }
    }

    /** Every vehicle of the day with its phase and how many stops and orders it carries: the vehicle choice. */
    fun vehicles(date: String): ObjectNode = synchronized(store) {
        store.validate(date)
        val snapshot = store.dispatch.snapshot(date)
        val dispatchPhase = snapshot.path("dispatch").path("phase").asString("unplanned")
        driverJson.createObjectNode().apply {
            put("date", date).put("dispatchPhase", dispatchPhase).put("operable", dispatchPhase in SELECTABLE_PHASES)
            set("vehicles", array(snapshot.path("fleetVehicles").toList().map { vehicle ->
                val id = vehicle.path("id").asString()
                val route = Route(snapshot, id)
                vehicleInfo(snapshot, id).apply {
                    put("phase", route.phase)
                    put("stops", route.stops.size)
                    put("orders", route.stops.sumOf { it.deliveries.size })
                }
            }))
        }
    }

    /** `{vehicleId, label, plate, region}` of one vehicle of the day. */
    private fun vehicleInfo(snapshot: ObjectNode, vehicleId: String): ObjectNode {
        val vehicle = snapshot.path("fleetVehicles").firstOrNull { it.path("id").asString() == vehicleId }
        fun text(key: String) = vehicle?.path(key)?.takeIf { it.isString }?.let { driverJson.stringNode(it.asString()) }
            ?: driverJson.nullNode()
        return driverJson.createObjectNode().put("vehicleId", vehicleId).apply {
            set("label", text("driver")); set("plate", text("plate")); set("region", text("region"))
        }
    }

    /** `[lng, lat]` of the stop's first order that has usable coordinates, or null. */
    private fun coordinatesOf(stop: RouteStop): JsonNode = stopPoint(stop)?.let {
        driverJson.createArrayNode().add(it.lng).add(it.lat)
    } ?: driverJson.nullNode()

    /** The automatic order proposal ([suggestRoute]); reads only, so it never changes the date. */
    fun suggest(date: String, vehicleId: String, lockFirst: String?): ObjectNode = synchronized(store) {
        store.validate(date, vehicleId)
        val route = Route(store.dispatch.snapshot(date), vehicleId)
        val sampled = sampledPoint(store.activity.latestLocations(date), vehicleId)
        suggestRoute(
            route, store.planner, SuggestOrigin(store.depot, sampled), lockFirst,
            store.eta.config.serviceMinutes, store.eta.config.speedKmh,
        ).apply { put("date", date) }
    }

    /** One stop's orders, customer, address, items, access, tip and requests, and the last completion photo there. */
    fun stop(date: String, vehicleId: String, stopId: String): ObjectNode = synchronized(store) {
        store.validate(date, vehicleId)
        val route = Route(store.dispatch.snapshot(date), vehicleId)
        val stop = route.stop(stopId)
        summary(stop, null).apply {
            putEta(this, route, stop)
            put("assignmentUnitId", stop.unitId)
            set("orders", array(stop.deliveries.map(::order)))
            set("previousPhoto", previousPhoto(date, stop.unitId) ?: driverJson.nullNode())
        }
    }

    /** Completed and undelivered stops of the day, by completion time. */
    fun history(date: String, vehicleId: String): ObjectNode = synchronized(store) {
        store.validate(date, vehicleId)
        val snapshot = store.dispatch.snapshot(date)
        val records = store.load(date).path("events").toList().filter { it.path("type").asString() in STOP_RESULTS }
        val done = Route(snapshot, vehicleId).stops.filter { it.status in setOf("done", "skipped") }
        val items = done.map { stop ->
            val record = records.lastOrNull { it.path("stopId").asString() == stop.stopId }
            summary(stop, null).apply {
                val derived = if (stop.status == "done") "completed" else "failed"
                put("result", STOP_RESULTS[record?.path("type")?.asString()] ?: derived)
                val at = completedAt(snapshot, vehicleId, stop.stopId)
                set("completedAt", at?.let { driverJson.stringNode(it) } ?: driverJson.nullNode())
                record?.let { copyDetails(it, this) }
            }
        }.sortedBy { it.path("completedAt").asString("") }
        driverJson.createObjectNode().put("date", date).put("vehicleId", vehicleId).apply { set("items", array(items)) }
    }

    /**
     * What drivers wrote on completion or failure across the day's vehicles, newest first. Only events with a
     * non-blank `note` are listed; the stop's name and address come from the date, so a stop that left the date shows
     * without them.
     */
    fun notes(date: String): ObjectNode = synchronized(store) {
        store.validate(date)
        val snapshot = store.dispatch.snapshot(date)
        val routes = HashMap<String, Route>()
        val items = store.load(date).path("events").toList().filter {
            it.path("type").asString() in STOP_RESULTS && it.path("note").asString("").isNotBlank()
        }.map { record ->
            val vehicleId = record.path("vehicleId").asString()
            val stopId = record.path("stopId").asString("")
            val route = routes.getOrPut(vehicleId) { Route(snapshot, vehicleId) }
            val stop = route.stops.firstOrNull { it.stopId == stopId }
            val vehicle = snapshot.path("fleetVehicles").firstOrNull { it.path("id").asString() == vehicleId }
            driverJson.createObjectNode().apply {
                put("vehicleId", vehicleId)
                put("driver", vehicle?.path("driver")?.asString("") ?: "")
                put("stopId", stopId)
                put("name", stop?.deliveries?.first()?.path("name")?.asString("") ?: "")
                put("address", stop?.deliveries?.first()?.path("address")?.asString("") ?: "")
                put("result", STOP_RESULTS.getValue(record.path("type").asString()))
                put("note", record.path("note").asString())
                if (record.has("reasonCode")) set("reasonCode", record.path("reasonCode").deepCopy())
                put("at", record.path("receivedAt").asString(record.path("occurredAt").asString("")))
            }
        }.sortedByDescending { it.path("at").asString() }
        driverJson.createObjectNode().put("date", date).apply { set("items", array(items)) }
    }

    private fun summary(stop: RouteStop, sequence: Int?): ObjectNode = driverJson.createObjectNode().apply {
        put("stopId", stop.stopId)
        sequence?.let { put("sequence", it) }
        set("orderIds", array(stop.orderIds.map { driverJson.stringNode(it) }))
        put("name", stop.deliveries.first().path("name").asString())
        put("address", stop.deliveries.first().path("address").asString())
        put("boxes", stop.deliveries.sumOf { it.path("boxes").doubleValue() })
        put("status", stop.status)
    }

    /** `eta` and `estimated` of a stop; both are null before the vehicle's departure computed them. */
    private fun putEta(target: ObjectNode, route: Route, stop: RouteStop) {
        val entry = route.etaOf(stop.stopId)
        target.set("eta", entry?.path("eta") ?: driverJson.nullNode())
        target.set("estimated", entry?.path("estimated") ?: driverJson.nullNode())
    }

    private fun order(delivery: JsonNode): ObjectNode = driverJson.createObjectNode().apply {
        put("orderId", delivery.path("id").asString())
        put("status", delivery.path("status").asString())
        ORDER_FIELDS.forEach { set(it, if (delivery.has(it)) delivery.path(it).deepCopy() else driverJson.nullNode()) }
    }

    private fun copyDetails(record: JsonNode, target: ObjectNode) {
        listOf("reasonCode", "note", "photoIds", "items", "scannedCodes").forEach {
            if (record.has(it)) target.set(it, record.path(it).deepCopy())
        }
    }

    /** The completion time is the operational event the engine recorded, not the app's own clock. */
    private fun completedAt(snapshot: ObjectNode, vehicleId: String, stopId: String): String? =
        snapshot.path("events").toList().firstOrNull {
            it.path("vehicleId").asString() == vehicleId && it.path("stopId").asString() == stopId &&
                it.path("action").asString() in setOf("completed", "toggle_skip")
        }?.let {
            Instant.ofEpochMilli(it.path("ts").asLong()).atZone(SEOUL).truncatedTo(ChronoUnit.SECONDS)
                .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
        }

    // ponytail: scans the latest 14 earlier driver files per call; add an index by destination if that gets slow.
    private fun previousPhoto(date: String, unitId: String): ObjectNode? {
        val earlier = Files.newDirectoryStream(store.directory).use { entries ->
            entries.mapNotNull { path ->
                PRIOR_FILE.matchEntire(path.fileName.toString())?.let { it.groupValues[1] to path }
            }.filter { it.first < date }.sortedByDescending { it.first }.take(MAX_PRIOR_FILES)
        }
        return earlier.firstNotNullOfOrNull { (day, path) ->
            val events = runCatching {
                check(Files.isRegularFile(path, NOFOLLOW_LINKS) && Files.size(path) <= DriverStore.MAX_FILE_BYTES)
                driverJson.readTree(Files.readAllBytes(path)).path("events")
            }.getOrNull() ?: return@firstNotNullOfOrNull null
            events.toList().lastOrNull {
                it.path("assignmentUnitId").asString() == unitId && it.path("type").asString() != "stop_failed" &&
                    it.path("photoIds").size() > 0
            }
                ?.let {
                    driverJson.createObjectNode().put("photoId", it.path("photoIds").first().asString())
                        .put("date", day).put("completedAt", it.path("occurredAt").asString())
                }
        }
    }

    private fun array(values: List<JsonNode>): ArrayNode = driverJson.createArrayNode().apply { values.forEach(::add) }
}
