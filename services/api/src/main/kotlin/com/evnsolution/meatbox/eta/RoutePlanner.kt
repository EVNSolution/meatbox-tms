package com.evnsolution.meatbox.eta

/**
 * One stop of the route in its current order. A [fixed] stop (current, done or skipped) keeps its position; only the
 * others are reordered. [address] only serves to place a stop without coordinates next to a similar one.
 */
class PlanStop(val stopId: String, val address: String, val point: EtaPoint?, val fixed: Boolean)

/** A stop without coordinates and the stop it was put behind (null: the end of the free stops). */
class Placement(val stopId: String, val afterStopId: String?)

/**
 * [order] holds every stop ID. [travelSeconds] is the travel along the free located stops, work time excluded.
 * [travelMeters] is the road distance of the same travel (null without a road engine) and [engine] names what timed
 * it (`osrm`, `haversine` after a fallback, null when no engine is configured).
 */
class RoutePlan(
    val order: List<String>,
    val travelSeconds: Int,
    val placed: List<Placement>,
    val travelMeters: Int? = null,
    val engine: String? = null,
)

/**
 * First automatic order over the stops that are not fixed: the [optimizer]'s (VROOM) when it answers, else nearest
 * neighbour from the origin improved by 2-opt.
 * Distances come from [estimator], so a routing API replaces the straight-line model without a change here (2-opt
 * reverses segments, so it assumes the travel time is the same both ways). It knows nothing about roads, left-turn
 * limits or arterials.
 */
class RoutePlanner(private val estimator: TravelTimeEstimator, private val optimizer: RouteOptimizer? = null) {
    /**
     * [origin] is where the vehicle starts the free stops; without it the first free located stop stays first.
     * [lockFirst] must be a free stop with coordinates and becomes the first free stop. Without [lockFirst] the result
     * is never longer than the current order.
     */
    fun plan(stops: List<PlanStop>, origin: EtaPoint?, lockFirst: String? = null): RoutePlan {
        val slots = stops.indices.filter { !stops[it].fixed }
        val free = slots.map { stops[it] }
        val located = free.filter { it.point != null }
        val unlocated = free.filter { it.point == null }
        val lockedAt = lockFirst?.let { id -> located.indexOfFirst { it.stopId == id } }
        require(lockedAt == null || lockedAt >= 0) { "lockFirst must be a free stop with coordinates" }

        val engine = estimator.prepare(listOfNotNull(origin) + located.mapNotNull { it.point })
        val path = Path(located, origin)
        val head = lockedAt ?: if (origin == null && located.isNotEmpty()) 0 else null
        val vroom = optimized(located, origin, head, path)
        val candidate = vroom ?: path.improve(path.nearest(head), head != null)
        val current = located.indices.toList()
        val best = if (lockedAt == null && path.seconds(current) <= path.seconds(candidate)) current else candidate

        val ids = best.map { located[it].stopId }.toMutableList()
        val placed = unlocated.map { stop ->
            val anchor = located.firstOrNull { similar(stop.address, it.address) }
                ?: unlocated.firstOrNull { it !== stop && it.stopId in ids && similar(stop.address, it.address) }
            ids.add(anchor?.let { ids.indexOf(it.stopId) + 1 } ?: ids.size, stop.stopId)
            Placement(stop.stopId, anchor?.stopId)
        }
        val order = stops.map { it.stopId }.toMutableList()
        slots.forEachIndexed { slot, index -> order[index] = ids[slot] }
        val named = engineName(vroom != null, engine)
        return RoutePlan(order, path.seconds(best), placed, path.meters(best, origin), named)
    }

    /** `vroom` when the optimizer ordered, else the estimator engine, else `haversine` if the optimizer failed. */
    private fun engineName(optimized: Boolean, estimated: String?): String? = when {
        optimized -> "vroom"
        estimated != null -> estimated
        optimizer != null -> "haversine"
        else -> null
    }

    /** The optimizer's order of the located free stops as positions in [located], or null without a usable answer. */
    private fun optimized(located: List<PlanStop>, origin: EtaPoint?, head: Int?, path: Path): List<Int>? =
        if (located.size > 1) {
            optimizer?.order(located, origin, head?.let { located[it].stopId })?.let { path.indicesOf(it) }
        } else {
            null
        }

    /** The first three words of both addresses match (a district and a road, or a road and a number). */
    private fun similar(left: String, right: String): Boolean {
        val a = left.trim().split(WORDS)
        val b = right.trim().split(WORDS)
        return a.size >= SIMILAR_WORDS && b.size >= SIMILAR_WORDS && a.take(SIMILAR_WORDS) == b.take(SIMILAR_WORDS)
    }

    /** Travel seconds between the located stops (by their index in the list) and from the origin, computed once. */
    private inner class Path(private val stops: List<PlanStop>, origin: EtaPoint?) {
        private val n = stops.size
        private val between = Array(n) { from ->
            IntArray(n) { to -> if (from == to) 0 else estimator.seconds(stops[from].point!!, stops[to].point!!) }
        }
        private val fromOrigin = IntArray(n) { next ->
            origin?.let { estimator.seconds(it, stops[next].point!!) } ?: 0
        }

        private fun leg(previous: Int, next: Int) = if (previous < 0) fromOrigin[next] else between[previous][next]

        /** The positions of [ids], or null when they are not exactly the stops of this path. */
        fun indicesOf(ids: List<String>): List<Int>? {
            val positions = ids.mapNotNull { id -> stops.indexOfFirst { it.stopId == id }.takeIf { it >= 0 } }
            return positions.takeIf { it.size == n && it.toSet().size == n }
        }

        fun seconds(order: List<Int>): Int = order.indices.sumOf { leg(if (it == 0) -1 else order[it - 1], order[it]) }

        /** The road distance along [order], or null when the estimator has none for some leg. */
        fun meters(order: List<Int>, origin: EtaPoint?): Int? {
            val points = listOfNotNull(origin) + order.map { stops[it].point!! }
            val legs = points.zipWithNext().map { (from, to) -> estimator.meters(from, to) }
            return if (legs.any { it == null }) null else legs.sumOf { it!! }
        }

        /** [head] (when set) goes first; otherwise the stop nearest the origin does. */
        fun nearest(head: Int?): MutableList<Int> {
            val rest = (0 until n).toMutableList()
            val order = mutableListOf<Int>()
            if (rest.isEmpty()) return order
            order += (head ?: rest.minBy { fromOrigin[it] }).also { rest.remove(it) }
            while (rest.isNotEmpty()) order += rest.minBy { between[order.last()][it] }.also { rest.remove(it) }
            return order
        }

        // ponytail: at most MAX_PASSES passes of O(n^2) reversals; the driver events cap a route at 200 stops.
        fun improve(order: MutableList<Int>, headFixed: Boolean): List<Int> {
            repeat(MAX_PASSES) {
                var better = false
                for (i in (if (headFixed) 1 else 0) until n - 1) for (j in i + 1 until n) {
                    val before = if (i == 0) -1 else order[i - 1]
                    var delta = leg(before, order[j]) - leg(before, order[i])
                    if (j < n - 1) delta += between[order[i]][order[j + 1]] - between[order[j]][order[j + 1]]
                    if (delta < 0) {
                        order.subList(i, j + 1).reverse()
                        better = true
                    }
                }
                if (!better) return order
            }
            return order
        }
    }

    private companion object {
        const val MAX_PASSES = 100
        const val SIMILAR_WORDS = 3
        val WORDS = Regex("\\s+")
    }
}
