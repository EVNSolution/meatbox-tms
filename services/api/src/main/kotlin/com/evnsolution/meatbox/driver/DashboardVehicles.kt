package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.eta.EtaPoint
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
private const val MS_PER_MINUTE = 60_000.0
private const val EARTH_RADIUS_KM = 6371.0088
private const val TENTH = 10.0
private const val METRES_PER_KM = 1000.0

/** The per-vehicle rows of the [Dashboard]: times from the engine's events, figures from the route. */
internal class DashboardVehicles(private val store: DriverStore) {
    fun rows(snapshot: ObjectNode, active: IncentiveRules?, owners: Map<String, String>) =
        snapshot.path("fleetVehicles").toList().mapNotNull { vehicle ->
            val id = vehicle.path("id").asString()
            val route = Route(snapshot, id)
            if (route.stops.isEmpty()) null else vehicleRow(snapshot, vehicle, route, active, owners[id])
        }

    private fun vehicleRow(
        snapshot: ObjectNode,
        vehicle: JsonNode,
        route: Route,
        active: IncentiveRules?,
        username: String?,
    ): ObjectNode {
        val orders = route.stops.flatMap { it.deliveries }
        val done = orders.filter { it.path("status").asString() == "done" }
        val closed = route.stops.count { it.status == "done" || it.status == "skipped" }
        val events = snapshot.path("events").toList().filter { it.path("vehicleId").asString() == route.vehicleId }
        val departed = events.filter { it.path("action").asString() == "shipping" }
            .minOfOrNull { it.path("ts").asLong() }
        val arrived = events.filter { it.path("action").asString() == "arrived" }.maxOfOrNull { it.path("ts").asLong() }
        val finished = events.filter { it.path("action").asString() in setOf("completed", "toggle_skip") }
            .maxOfOrNull { it.path("ts").asLong() }?.takeIf { closed == route.stops.size }
        val minutes = if (departed == null || finished == null) {
            null
        } else {
            roundTenth((finished - departed) / MS_PER_MINUTE)
        }
        val boxes = orders.sumOf { it.path("boxes").asDouble() }
        val stopsDone = route.stops.count { it.status == "done" }
        return driverJson.createObjectNode().apply {
            put("vehicleId", route.vehicleId).put("plate", vehicle.path("plate").asString(""))
            put("label", vehicle.path("driver").asString(""))
            if (username == null) putNull("driver") else put("driver", username)
            put("stops", route.stops.size).put("boxes", boxes).put("orders", orders.size)
            put("stopsDone", stopsDone).put("boxesDelivered", done.sumOf { it.path("boxes").asDouble() })
            put("ordersDone", done.size)
            put("stopsSkipped", route.stops.count { it.status == "skipped" })
            setTime("departedAt", departed).setTime("lastArrivedAt", arrived).setTime("finishedAt", finished)
            if (minutes == null) putNull("driveMinutes") else put("driveMinutes", minutes)
            val distance = distanceOf(route)
            if (distance == null) putNull("distanceKm") else put("distanceKm", distance.km)
            put("distanceBasis", if (distance?.road == true) "road-plan" else "estimate").putNull("actualKm")
            put("boxesPerStop", roundTenth(boxes / route.stops.size))
            if (minutes != null && stopsDone > 0) put("minutesPerStop", roundTenth(minutes / stopsDone))
            else putNull("minutesPerStop")
            if (active != null) set("incentive", incentiveOf(active, username, route.stops.size, stopsDone, done))
        }
    }

    private fun incentiveOf(
        rules: IncentiveRules,
        username: String?,
        stops: Int,
        stopsDone: Int,
        done: List<JsonNode>,
    ): ObjectNode {
        val delivered = when (rules.unit) {
            "stops" -> stopsDone.toDouble()
            "orders" -> done.size.toDouble()
            else -> done.sumOf { it.path("boxes").asDouble() }
        }
        val target = rules.targetOf(username)
        val excess = (delivered - target).coerceAtLeast(0.0)
        return driverJson.createObjectNode().put("target", target).put("delivered", delivered)
            .put("excess", excess).put("amount", Math.round(excess * rules.ratePerUnit)).put("stops", stops)
    }

    private class Distance(val km: Double, val road: Boolean)

    /**
     * From the depot (when set) through the stops with coordinates, in km. The road engine's planned distance when it
     * answers (`road`); else the straight line times the detour factor.
     */
    private fun distanceOf(route: Route): Distance? {
        val points = listOfNotNull(store.depot) + route.stops.mapNotNull(::stopPoint)
        if (route.stops.none { stopPoint(it) != null }) return null
        val legs = points.zipWithNext()
        val road = roadKilometres(points, legs)
        val line = legs.sumOf { (from, to) -> kilometres(from, to) }
        return Distance(roundTenth(road ?: (line * store.eta.config.detourFactor)), road != null)
    }

    /** The planned road distance of [legs], or null when the road engine does not answer every leg. */
    private fun roadKilometres(points: List<EtaPoint>, legs: List<Pair<EtaPoint, EtaPoint>>): Double? {
        val estimator = store.eta.estimator
        if (estimator.prepare(points) != "osrm") return null
        val metres = legs.map { (from, to) -> estimator.meters(from, to) }
        return if (metres.any { it == null }) null else metres.sumOf { it!! } / METRES_PER_KM
    }

    private fun kilometres(from: EtaPoint, to: EtaPoint): Double {
        val dLat = Math.toRadians(to.lat - from.lat)
        val dLng = Math.toRadians(to.lng - from.lng)
        val cosines = cos(Math.toRadians(from.lat)) * cos(Math.toRadians(to.lat))
        return 2 * EARTH_RADIUS_KM * asin(sqrt(sin(dLat / 2).pow(2) + cosines * sin(dLng / 2).pow(2)))
    }

    private fun roundTenth(value: Double): Double = Math.round(value * TENTH) / TENTH

    private fun ObjectNode.setTime(name: String, millis: Long?): ObjectNode = apply {
        if (millis == null) {
            putNull(name)
        } else {
            put(name, Instant.ofEpochMilli(millis).atZone(SEOUL).truncatedTo(ChronoUnit.SECONDS)
                .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME))
        }
    }
}
