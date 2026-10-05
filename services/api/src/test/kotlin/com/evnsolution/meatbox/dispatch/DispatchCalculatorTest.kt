@file:Suppress("MaxLineLength")

package com.evnsolution.meatbox.dispatch

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode

class DispatchCalculatorTest {
    @Test
    fun `keeps destination bundles together and deterministically follows geography`() {
        val orders = array(
            order("W1", "V1", 6, 126.80),
            order("W1-B", "V2", 3, 126.80),
            order("W2", "V1", 4, 126.81),
            order("E1", "V2", 5, 127.20),
            order("E2", "V2", 5, 127.21),
        )
        val units = listOf(unit("UW1", "W1", "W1-B"), unit("UW2", "W2"), unit("UE1", "E1"), unit("UE2", "E2"))
        val vehicles = listOf(vehicle("V1"), vehicle("V2"), vehicle("V3"))

        val first = DispatchCalculator.calculate(orders, vehicles, listOf("V1", "V2"), units)
        val second = DispatchCalculator.calculate(copyNode(orders) as ArrayNode, vehicles.map(::copyObject), listOf("V1", "V2"), units.map(::copyObject))

        assertThat(first).isEqualTo(second)
        assertThat(first.propertyNames()).containsExactlyInAnyOrder("W1", "W1-B", "W2", "E1", "E2")
        assertThat(first["W1"].asString()).isEqualTo(first["W1-B"].asString())
        assertThat(first["W1"].asString()).isEqualTo(first["W2"].asString()).isEqualTo("V1")
        assertThat(first["E1"].asString()).isEqualTo(first["E2"].asString()).isEqualTo("V2")
    }

    @Test
    fun `merges connected zones and balances unlocated destinations without splitting`() {
        val orders = array(
            order("A", "V1", 8, 126.8, listOf("Z1")),
            order("B", "V1", 2, 126.9, listOf("Z1", "Z2")),
            order("C", "V2", 7, 127.2, listOf("Z2")),
            order("M", "V2", 100, null),
        )
        val result = DispatchCalculator.calculate(
            orders,
            listOf(vehicle("V1"), vehicle("V2"), vehicle("V3")),
            listOf("V1", "V2", "V3"),
            listOf(unit("A", "A"), unit("B", "B"), unit("C", "C"), unit("M", "M")),
        )

        assertThat(result["A"].asString()).isEqualTo(result["B"].asString()).isEqualTo(result["C"].asString())
        assertThat(result["M"].asString()).isIn("V1", "V2", "V3")
    }

    @Test
    fun `rejects missing candidates and incomplete or duplicate unit coverage`() {
        val orders = array(order("O1", "V1", 1, 127.0))
        val vehicles = listOf(vehicle("V1"))

        assertThatThrownBy { DispatchCalculator.calculate(orders, vehicles, emptyList(), listOf(unit("U1", "O1"))) }
            .isInstanceOf(DispatchException::class.java).hasMessageContaining("한 대 이상")
        assertThatThrownBy { DispatchCalculator.calculate(orders, vehicles, listOf("UNKNOWN"), listOf(unit("U1", "O1"))) }
            .isInstanceOf(DispatchException::class.java).hasMessageContaining("찾을 수 없습니다")
        assertThatThrownBy { DispatchCalculator.calculate(orders, vehicles, listOf("V1"), emptyList()) }
            .isInstanceOf(DispatchException::class.java).hasMessageContaining("모든 주문")
        assertThatThrownBy { DispatchCalculator.calculate(orders, vehicles, listOf("V1"), listOf(unit("U1", "O1"), unit("U2", "O1"))) }
            .isInstanceOf(DispatchException::class.java).hasMessageContaining("주문을 확인")
    }

    private fun vehicle(id: String): ObjectNode = dispatchMapper.createObjectNode().apply { put("id", id) }

    private fun order(id: String, groupId: String, boxes: Int, longitude: Double?, zones: List<String>? = null): ObjectNode =
        dispatchMapper.createObjectNode().apply {
            put("id", id)
            put("groupId", groupId)
            put("boxes", boxes)
            if (longitude == null) putNull("coordinates") else putArray("coordinates").add(longitude).add(37.5)
            zones?.let { set("zoneIds", strings(it)) }
        }

    private fun unit(id: String, vararg orderIds: String): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("id", id)
        set("orderIds", strings(orderIds.asList()))
    }

    private fun array(vararg values: ObjectNode): ArrayNode = dispatchMapper.createArrayNode().apply { values.forEach(::add) }
    private fun strings(values: List<String>): ArrayNode = dispatchMapper.createArrayNode().apply { values.forEach(::add) }
}
