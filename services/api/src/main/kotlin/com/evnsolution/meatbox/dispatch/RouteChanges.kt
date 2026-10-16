package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.node.ObjectNode

/** How one vehicle's list of orders differs after an operator command. */
data class RouteChange(val vehicleId: String, val added: Int, val removed: Int, val reordered: Boolean) {
    /** One line for the driver's notification. */
    fun describe(): String {
        val parts = buildList {
            if (added > 0) add("주문 추가 ${added}건")
            if (removed > 0) add("제외 ${removed}건")
            if (reordered) add("순서 변경")
        }
        return "배차가 변경되었습니다. ${parts.joinToString(" · ")}"
    }
}

/**
 * Called after an operator command changed some vehicles' orders. It runs under the store lock, so it must only
 * queue work.
 */
fun interface RouteChangeListener {
    fun changed(date: String, revision: Long, changes: List<RouteChange>)
}

/** The commands that can move orders between vehicles or reorder them. Driver events are not among them. */
internal val ROUTE_CHANGING_COMMANDS = setOf("publish_dispatch", "reassign", "set_route_order")

private fun ordersByVehicle(snapshot: ObjectNode): Map<String, List<String>> =
    snapshot.path("fleetDeliveries").toList()
        .groupBy({ it.path("vehicleId").asString() }, { it.path("id").asString() })

/** The vehicles whose orders were added, removed or put in another relative order between the two snapshots. */
internal fun routeChanges(before: ObjectNode, after: ObjectNode): List<RouteChange> {
    val was = ordersByVehicle(before)
    val now = ordersByVehicle(after)
    return (was.keys + now.keys).sorted().mapNotNull { vehicleId ->
        val old = was[vehicleId].orEmpty()
        val new = now[vehicleId].orEmpty()
        val added = new.count { it !in old }
        val removed = old.count { it !in new }
        val reordered = old.filter { it in new } != new.filter { it in old }
        RouteChange(vehicleId, added, removed, reordered).takeIf { added > 0 || removed > 0 || reordered }
    }
}
