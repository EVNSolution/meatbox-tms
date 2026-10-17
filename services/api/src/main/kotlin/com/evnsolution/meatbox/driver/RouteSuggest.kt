package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.PlanStop
import com.evnsolution.meatbox.eta.RoutePlan
import com.evnsolution.meatbox.eta.RoutePlanner
import org.springframework.http.HttpStatus
import tools.jackson.databind.node.ObjectNode
import kotlin.math.roundToInt

private const val SECONDS_PER_MINUTE = 60
private const val SECONDS_PER_HOUR = 3600.0
private const val TENTHS = 10
private const val METRES_PER_KM = 1000.0

private val PlanStop.canLead get() = !fixed && point != null

/** Where the free stops are driven from: the truck's place once it is delivering, else the depot. */
internal class SuggestOrigin(val depot: EtaPoint?, val sampled: EtaPoint?)

/**
 * The automatic order for one vehicle's open stops, as a proposal: nothing is written. Stops that are not `pending`
 * keep their place, as `route_reordered` demands after the departure. The route starts at the newest reported
 * position once the vehicle is delivering, else at the depot, else at the other one; with none, the first free stop
 * stays first. [lockFirst] (any order ID of a stop) must be a free stop with coordinates.
 */
internal fun suggestRoute(
    route: Route,
    planner: RoutePlanner,
    where: SuggestOrigin,
    lockFirst: String?,
    serviceMinutes: Int,
    speedKmh: Double,
): ObjectNode {
    if (route.phase == "done") driverFail(HttpStatus.CONFLICT.value(), "ROUTE_LOCKED")
    val stops = route.stops.map {
        PlanStop(it.stopId, it.deliveries.first().path("address").asString(), stopPoint(it), it.status != "pending")
    }
    val locked = lockFirst?.let { route.stop(it).stopId }
    if (locked != null && stops.none { it.stopId == locked && it.canLead }) invalidInput()
    // ponytail: the closed stop before the first free slot stands for the truck's place when the app sent none.
    val firstFree = stops.indexOfFirst { !it.fixed }
    val lastClosed = stops.take(maxOf(firstFree, 0)).lastOrNull { it.point != null }?.point
    val origin = if (route.phase == "delivering") {
        where.sampled ?: lastClosed ?: where.depot
    } else {
        where.depot ?: where.sampled
    }
    val plan = planner.plan(stops, origin, locked)
    val free = maxOf(stops.count { !it.fixed } - 1, 0)
    val seconds = plan.travelSeconds + free * serviceMinutes * SECONDS_PER_MINUTE
    return proposal(route, plan, stops.map { it.stopId }, seconds, speedKmh)
}

private fun proposal(route: Route, plan: RoutePlan, current: List<String>, seconds: Int, speedKmh: Double) =
    driverJson.createObjectNode().apply {
        put("vehicleId", route.vehicleId)
        put("revision", route.revision)
        set("stopOrder", driverJson.createArrayNode().apply { plan.order.forEach(::add) })
        put("changed", plan.order != current)
        put("totalMinutes", (seconds.toDouble() / SECONDS_PER_MINUTE).roundToInt())
        val km = plan.travelMeters?.let { it / METRES_PER_KM } ?: (plan.travelSeconds / SECONDS_PER_HOUR * speedKmh)
        put("totalKm", (km * TENTHS).roundToInt().toDouble() / TENTHS)
        plan.engine?.let { put("engine", it) }
        set("placed", driverJson.createArrayNode().apply {
            plan.placed.forEach {
                add(
                    driverJson.createObjectNode().put("stopId", it.stopId).put("placed", "no-coordinates")
                        .set("afterStopId", it.afterStopId?.let(driverJson::stringNode) ?: driverJson.nullNode()),
                )
            }
        })
    }
