package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.LocalDate
import java.time.temporal.ChronoUnit

private const val MAX_DAYS = 31L
private val CONFIRMED = setOf("published", "amending")

private fun array(items: List<JsonNode>) = driverJson.createArrayNode().apply { items.forEach(::add) }

/**
 * The operator's view of finished and running days (requirement 24, 29): per date the orders, boxes and stops, and per
 * vehicle the departure, the last arrival, the time it took, the distance, boxes per stop, minutes per stop and the
 * extra fee over the daily target. Everything is derived from the date snapshots, so it adds no store of its own.
 *
 * The distance is an estimate: the straight line through the route in its current order, times the ETA model's detour
 * factor. The server keeps no driven track (only the newest 120 location samples), so `actualKm` is always null.
 * Who drives a vehicle is the standing assignment as of now, not as of the date.
 */
class Dashboard internal constructor(
    private val store: DriverStore,
    private val assignments: DriverAssignments,
    private val rules: IncentiveRulesFile,
) {
    private val vehicles = DashboardVehicles(store)

    fun range(from: String, to: String): ObjectNode = synchronized(store) {
        val first = day(from)
        val last = day(to)
        if (last.isBefore(first)) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_RANGE")
        if (ChronoUnit.DAYS.between(first, last) + 1 > MAX_DAYS) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "RANGE_TOO_LARGE")
        }
        val found = rules.read()
        val active = (found as? IncentiveRulesFile.Result.Found)?.rules
        val owners = assignments.view().assignments
        driverJson.createObjectNode().apply {
            put("from", from).put("to", to)
            when (found) {
                is IncentiveRulesFile.Result.Found -> set("incentiveRules", found.rules.toNode())
                IncentiveRulesFile.Result.Missing -> putNull("incentiveRules")
                IncentiveRulesFile.Result.Invalid -> put("incentiveRulesError", "INCENTIVE_RULES_INVALID")
            }
            val days = putArray("days")
            generateSequence(first) { it.plusDays(1) }.takeWhile { !it.isAfter(last) }
                .forEach { date -> dayRow(date.toString(), active, owners)?.let(days::add) }
        }
    }

    private fun day(value: String): LocalDate =
        runCatching { LocalDate.parse(value) }.getOrNull()?.takeIf { it.toString() == value }
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_DATE")

    /** One date, or null when the date has no source at all (nothing was ordered). */
    private fun dayRow(date: String, active: IncentiveRules?, owners: Map<String, String>): ObjectNode? {
        val loaded = runCatching { store.dispatch.snapshot(date) }
        val error = loaded.exceptionOrNull()
        if (error != null && error !is DispatchException) throw error
        return when {
            (error as? DispatchException)?.status == HttpStatus.NOT_FOUND.value() -> null
            error != null -> failed(date, error as DispatchException)
            else -> build(date, loaded.getOrThrow(), active, owners)
        }
    }

    private fun failed(date: String, error: DispatchException): ObjectNode =
        driverJson.createObjectNode().put("date", date).put("error", error.code)

    private fun build(
        date: String,
        snapshot: ObjectNode,
        active: IncentiveRules?,
        owners: Map<String, String>,
    ): ObjectNode {
        val phase = snapshot.path("dispatch").path("phase").asString("unplanned")
        val orders = snapshot.path("fleetDeliveries").toList()
        return driverJson.createObjectNode().apply {
            put("date", date).put("phase", phase).put("orders", orders.size)
            put("boxes", orders.sumOf { it.path("boxes").asDouble() })
            put("stops", orders.groupBy { it.path("assignmentUnitId").asString() }.size)
            val rows = if (phase in CONFIRMED) vehicles.rows(snapshot, active, owners) else emptyList()
            set("vehicles", array(rows))
            set("zones", zoneRows(orders))
            put("unlocatedOrders", orders.count { zoneIds(it).isEmpty() })
            if (active != null) set("incentive", incentiveTotal(rows))
        }
    }

    private fun incentiveTotal(vehicles: List<ObjectNode>): ObjectNode {
        val paid = vehicles.filter { it.path("incentive").path("excess").asDouble() > 0 }
        return driverJson.createObjectNode().put("people", paid.size)
            .put("amount", paid.sumOf { it.path("incentive").path("amount").asLong() })
    }

    private fun zoneRows(orders: List<JsonNode>) = array(
        orders.flatMap { order -> zoneIds(order).map { it to order } }.groupBy({ it.first }, { it.second })
            .toSortedMap().map { (zone, rows) ->
                driverJson.createObjectNode().put("zoneId", zone).put("orders", rows.size)
                    .put("boxes", rows.sumOf { it.path("boxes").asDouble() })
                    .put("stops", rows.groupBy { it.path("assignmentUnitId").asString() }.size)
            },
    )

    private fun zoneIds(order: JsonNode): List<String> =
        order.path("zoneIds").toList().filter { it.isString }.map { it.asString() }.distinct()
}
