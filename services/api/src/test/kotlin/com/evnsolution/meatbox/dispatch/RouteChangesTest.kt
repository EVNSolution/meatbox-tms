package com.evnsolution.meatbox.dispatch

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import tools.jackson.databind.node.ObjectNode

class RouteChangesTest {
    private fun snapshot(vararg routes: Pair<String, List<String>>): ObjectNode {
        val root = dispatchMapper.createObjectNode()
        val deliveries = root.putArray("fleetDeliveries")
        routes.forEach { (vehicleId, ids) ->
            ids.forEach { deliveries.addObject().put("vehicleId", vehicleId).put("id", it) }
        }
        return root
    }

    @Test
    fun `reports added removed and reordered orders per vehicle and skips vehicles that did not change`() {
        val before = snapshot("G1" to listOf("a", "b", "c"), "G2" to listOf("x"), "G3" to listOf("m", "n"))
        val after = snapshot(
            "G1" to listOf("c", "b", "d"), "G2" to listOf("x"), "G4" to listOf("p"), "G3" to listOf("m", "n"),
        )
        assertThat(routeChanges(before, after)).containsExactly(
            RouteChange("G1", added = 1, removed = 1, reordered = true),
            RouteChange("G4", added = 1, removed = 0, reordered = false),
        )
    }

    @Test
    fun `a pure reorder and a pure removal are told apart`() {
        assertThat(routeChanges(snapshot("G1" to listOf("a", "b")), snapshot("G1" to listOf("b", "a"))))
            .containsExactly(RouteChange("G1", 0, 0, true))
        assertThat(routeChanges(snapshot("G1" to listOf("a", "b")), snapshot("G1" to listOf("a"))))
            .containsExactly(RouteChange("G1", 0, 1, false))
        assertThat(routeChanges(snapshot("G1" to listOf("a")), snapshot("G1" to listOf("a")))).isEmpty()
    }

    @Test
    fun `the notification line names only what changed`() {
        assertThat(RouteChange("G1", 2, 0, false).describe()).isEqualTo("배차가 변경되었습니다. 주문 추가 2건")
        assertThat(RouteChange("G1", 1, 3, true).describe()).isEqualTo("배차가 변경되었습니다. 주문 추가 1건 · 제외 3건 · 순서 변경")
        assertThat(RouteChange("G1", 0, 0, true).describe()).isEqualTo("배차가 변경되었습니다. 순서 변경")
    }
}
