package com.evnsolution.meatbox.eta

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class RoutePlannerOptimizerTest {
    private val estimator = HaversineEstimator(EtaConfig())
    private val depot = EtaPoint(37.5, 127.0)

    private fun stop(id: String, lng: Double?, fixed: Boolean = false) =
        PlanStop(id, "주소 $id", lng?.let { EtaPoint(37.5, it) }, fixed)

    private fun planner(answer: (List<PlanStop>, String?) -> List<String>?) =
        RoutePlanner(estimator) { stops, _, first -> answer(stops, first) }

    // Current order D (far), C, B, A (near): the optimizer's order is shorter than it, so it is kept.
    private val stops = listOf(stop("D", 127.4), stop("C", 127.3), stop("B", 127.2), stop("A", 127.1))

    @Test
    fun `the optimizer's order is used and named vroom`() {
        val plan = planner { _, _ -> listOf("B", "A", "C", "D") }.plan(stops, depot)
        assertThat(plan.order).containsExactly("B", "A", "C", "D")
        assertThat(plan.engine).isEqualTo("vroom")
    }

    @Test
    fun `fixed stops keep their place and the optimizer only sees the free located stops`() {
        val mixed = listOf(stop("X", 127.9, fixed = true)) + stops.take(3) + stop("N", null)
        var seen: List<String>? = null
        val plan = planner { free, _ -> free.map { it.stopId }.also { seen = it }.reversed() }.plan(mixed, depot)
        assertThat(seen).containsExactly("D", "C", "B")
        assertThat(plan.order.first()).isEqualTo("X")
        assertThat(plan.order).containsExactlyInAnyOrderElementsOf(mixed.map { it.stopId })
        assertThat(plan.placed.map { it.stopId }).containsExactly("N")
    }

    @Test
    fun `lockFirst is handed over as the first stop`() {
        var first: String? = "unset"
        val plan = planner { _, lead -> first = lead; listOf("C") + listOf("A", "B", "D") }.plan(stops, depot, "C")
        assertThat(first).isEqualTo("C")
        assertThat(plan.order.first()).isEqualTo("C")
    }

    @Test
    fun `no answer or a broken answer plans with 2-opt and names the fallback`() {
        val plain = RoutePlanner(estimator).plan(stops, depot)
        listOf(null, listOf("A"), listOf("A", "A", "B", "C"), listOf("A", "B", "C", "Z")).forEach { answer ->
            val plan = planner { _, _ -> answer }.plan(stops, depot)
            assertThat(plan.order).isEqualTo(plain.order)
            assertThat(plan.engine).isEqualTo("haversine")
        }
        assertThat(plain.engine).isNull()
    }

    @Test
    fun `an optimizer answer that is longer than the current order is not proposed`() {
        val near = listOf(stop("A", 127.1), stop("B", 127.2), stop("C", 127.3))
        val plan = planner { _, _ -> listOf("C", "B", "A") }.plan(near, depot)
        assertThat(plan.order).containsExactly("A", "B", "C")
    }

    @Test
    fun `a single located stop never asks the optimizer`() {
        var asked = false
        planner { _, _ -> asked = true; null }.plan(listOf(stop("A", 127.1), stop("N", null)), depot)
        assertThat(asked).isFalse()
    }
}
