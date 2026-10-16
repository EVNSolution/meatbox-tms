package com.evnsolution.meatbox.eta

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import kotlin.random.Random

class RoutePlannerTest {
    private val estimator = HaversineEstimator(EtaConfig())
    private val planner = RoutePlanner(estimator)
    private val depot = EtaPoint(37.5, 127.0)

    private fun stop(id: String, lat: Double?, lng: Double?, fixed: Boolean = false, address: String = "주소 $id") =
        PlanStop(id, address, if (lat != null && lng != null) EtaPoint(lat, lng) else null, fixed)

    private fun scattered(count: Int, seed: Int): List<PlanStop> {
        val random = Random(seed)
        return List(count) { stop("S$it", 37.3 + random.nextDouble() * 0.4, 126.8 + random.nextDouble() * 0.4) }
    }

    private fun seconds(stops: List<PlanStop>, order: List<String>, origin: EtaPoint?): Int {
        val byId = stops.associateBy { it.stopId }
        var position = origin
        var total = 0
        order.mapNotNull { byId.getValue(it).point }.forEach { point ->
            position?.let { total += estimator.seconds(it, point) }
            position = point
        }
        return total
    }

    @Test
    fun `nearest neighbour with 2-opt is shorter than the average random order`() {
        listOf(12, 30, 60).forEachIndexed { index, count ->
            val stops = scattered(count, seed = index + 1)
            val plan = planner.plan(stops, depot)
            val random = Random(99)
            val shuffled = List(20) { seconds(stops, stops.map { it.stopId }.shuffled(random), depot) }
            assertThat(plan.order).containsExactlyInAnyOrderElementsOf(stops.map { it.stopId })
            assertThat(plan.travelSeconds).isEqualTo(seconds(stops, plan.order, depot))
            assertThat(plan.travelSeconds).isLessThan(shuffled.average().toInt() / 2)
            assertThat(plan.travelSeconds).isLessThanOrEqualTo(shuffled.min())
        }
    }

    @Test
    fun `2-opt removes a crossing that nearest neighbour leaves`() {
        // Along a line the nearest-first walk is optimal, so use a layout whose greedy walk ends with a long jump.
        val stops = listOf(
            stop("A", 37.50, 127.00), stop("B", 37.50, 127.02), stop("C", 37.52, 127.02), stop("D", 37.52, 127.00),
            stop("E", 37.54, 127.00), stop("F", 37.54, 127.02),
        )
        val reversed = stops.reversed()
        val plan = planner.plan(reversed, depot)
        assertThat(plan.travelSeconds).isLessThanOrEqualTo(seconds(reversed, reversed.map { it.stopId }, depot))
        assertThat(plan.travelSeconds).isLessThanOrEqualTo(seconds(stops, listOf("A", "B", "C", "D", "E", "F"), depot))
    }

    @Test
    fun `never proposes a longer order than the current one`() {
        val stops = listOf(stop("A", 37.50, 127.01), stop("B", 37.50, 127.02), stop("C", 37.50, 127.03))
        val plan = planner.plan(stops, depot)
        assertThat(plan.order).containsExactly("A", "B", "C")
    }

    @Test
    fun `stops without coordinates follow a similar address or go last and are reported`() {
        val stops = listOf(
            stop("A", 37.50, 127.05, address = "서울 강남구 테헤란로 1"),
            stop("B", 37.50, 127.01, address = "서울 송파구 올림픽로 2"),
            stop("X", null, null, address = "서울 강남구 테헤란로 99"),
            stop("Y", null, null, address = "부산 해운대구 해변로 5"),
            stop("Z", null, null, address = "짧은 주소"),
        )
        val plan = planner.plan(stops, depot)
        assertThat(plan.order).containsExactly("B", "A", "X", "Y", "Z")
        assertThat(plan.placed.map { it.stopId to it.afterStopId })
            .containsExactly("X" to "A", "Y" to null, "Z" to null)
    }

    @Test
    fun `fixed stops keep their place and the others fill the free slots`() {
        val stops = listOf(
            stop("done", 37.6, 127.1, fixed = true), stop("far", 37.50, 127.20), stop("near", 37.50, 127.01),
            stop("mid", 37.50, 127.10),
        )
        val plan = planner.plan(stops, depot)
        assertThat(plan.order).containsExactly("done", "near", "mid", "far")
    }

    @Test
    fun `lockFirst puts that stop first among the free ones`() {
        val stops = listOf(stop("near", 37.50, 127.01), stop("mid", 37.50, 127.10), stop("far", 37.50, 127.20))
        assertThat(planner.plan(stops, depot, lockFirst = "far").order.first()).isEqualTo("far")
        assertThatThrownBy { planner.plan(stops, depot, lockFirst = "nope") }
            .isInstanceOf(IllegalArgumentException::class.java)
        val withGap = stops + stop("x", null, null)
        assertThatThrownBy { planner.plan(withGap, depot, lockFirst = "x") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `without an origin the first free located stop stays first`() {
        val stops = listOf(stop("A", 37.50, 127.20), stop("B", 37.50, 127.01), stop("C", 37.50, 127.10))
        assertThat(planner.plan(stops, null).order).containsExactly("A", "C", "B")
        assertThat(planner.plan(emptyList(), null).order).isEmpty()
        assertThat(planner.plan(listOf(stop("only", null, null)), depot).order).containsExactly("only")
    }

    @Test
    fun `plans 200 stops quickly and deterministically`() {
        val stops = scattered(200, seed = 7)
        val started = System.nanoTime()
        val plan = planner.plan(stops, depot)
        assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(5_000)
        assertThat(plan.order).hasSize(200).doesNotHaveDuplicates()
        assertThat(planner.plan(stops, depot).order).isEqualTo(plan.order)
    }
}
