package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class DriverReadEndpointsTest {
    @TempDir lateinit var directory: Path

    private val items = """"items":[{"sku":"PK-001","name":"삼겹살 1kg","qty":3,"boxes":1,"barcode":"8801234567890"},
        {"sku":"PK-002","name":"목살","qty":2,"boxes":1}],"deliveryType":"fresh","csNote":"오전 배송",
        "access":{"entranceCode":"1234*","placeNote":"뒷문"}"""

    private fun fixture(
        coordinates: Map<String, String> = mapOf("O1" to "[127.01,37.51]", "O4" to "null"),
        extras: Map<String, String> = mapOf("O1" to items),
    ) = routeFixture(directory, coordinates = coordinates, extras = extras)

    @Test
    fun `the route carries the vehicle, whether the day is confirmed, positions and every order of every stop`() {
        val f = fixture()
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("operable").asBoolean()).isTrue()
        assertThat(route.path("dispatchPhase").asString()).isEqualTo("published")
        assertThat(route.path("vehicle").path("vehicleId").asString()).isEqualTo("G1")
        assertThat(route.path("vehicle").path("label").asString()).isEqualTo("합성 기사")
        val stops = route.path("stops").toList()
        assertThat(stops.map { it.path("stopId").asString() }).containsExactly("O1", "O3", "O4")
        assertThat(stops[0].path("coordinates").toList().map { it.asDouble() }).containsExactly(127.01, 37.51)
        assertThat(stops[2].path("coordinates").isNull).isTrue()
        val first = stops[0].path("orders").toList()
        assertThat(first.map { it.path("orderId").asString() }).containsExactly("O1", "O2")
        val withItems = first[0]
        assertThat(withItems.path("items")[0].path("barcode").asString()).isEqualTo("8801234567890")
        assertThat(withItems.path("items")[1].path("barcode").isMissingNode).isTrue()
        assertThat(withItems.path("deliveryType").asString()).isEqualTo("fresh")
        assertThat(withItems.path("csNote").asString()).isEqualTo("오전 배송")
        assertThat(withItems.path("access").path("entranceCode").asString()).isEqualTo("1234*")
        assertThat(first[1].path("items").isNull || first[1].path("items").isEmpty).isTrue()
        assertThat(first[1].path("csNote").isNull).isTrue()
    }

    @Test
    fun `the stop detail shows the same orders as the route`() {
        val f = fixture()
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        route.path("stops").forEach { stop ->
            val detail = f.driver.queries.stop(DRIVER_DATE, "G1", stop.path("stopId").asString())
            assertThat(detail.path("orders")).isEqualTo(stop.path("orders"))
        }
    }

    @Test
    fun `the vehicles list names every vehicle of the day with its phase, stops and orders`() {
        val f = fixture()
        val vehicles = f.driver.queries.vehicles(DRIVER_DATE)
        assertThat(vehicles.path("operable").asBoolean()).isTrue()
        val byId = vehicles.path("vehicles").toList().associateBy { it.path("vehicleId").asString() }
        assertThat(byId.keys).containsExactlyInAnyOrder("G1", "G2")
        assertThat(byId.getValue("G1").path("label").asString()).isEqualTo("합성 기사")
        assertThat(byId.getValue("G1").path("phase").asString()).isEqualTo("idle")
        assertThat(byId.getValue("G1").path("stops").asInt()).isEqualTo(3)
        assertThat(byId.getValue("G1").path("orders").asInt()).isEqualTo(4)
        assertThat(byId.getValue("G2").path("stops").asInt()).isZero()
        f.driver.activity.acceptEvent(DRIVER_DATE, driverJson.readTree(
            """{"eventId":"go","type":"departed","occurredAt":"2026-10-13T10:00:00+09:00","date":"$DRIVER_DATE",
            "vehicleId":"G1","payload":{}}""",
        ) as tools.jackson.databind.node.ObjectNode)
        val after = f.driver.queries.vehicles(DRIVER_DATE).path("vehicles")
            .first { it.path("vehicleId").asString() == "G1" }
        assertThat(after.path("phase").asString()).isEqualTo("delivering")
    }

    @Test
    fun `a day that is not confirmed yet is not operable`() {
        var before: String? = null
        var vehicles = 0
        routeFixture(directory, beforePublish = { f ->
            before = f.driver.queries.vehicles(DRIVER_DATE).path("dispatchPhase").asString()
            vehicles = f.driver.queries.vehicles(DRIVER_DATE).path("vehicles").size()
            assertThat(f.driver.queries.vehicles(DRIVER_DATE).path("operable").asBoolean()).isFalse()
            assertThat(f.driver.queries.route(DRIVER_DATE, "G1").path("operable").asBoolean()).isFalse()
        })
        assertThat(before).isNotEqualTo("published")
        assertThat(vehicles).isEqualTo(2)
    }

    @Test
    fun `the vehicles list rejects a bad date`() {
        val f = fixture()
        assertThatThrownBy { f.driver.queries.vehicles("2026-13-40") }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(400)
                assertThat(it.code).isEqualTo("INVALID_DATE")
            }
    }

    @Test
    fun `a full day of 200 stops with 3 orders each stays well under a megabyte`() {
        val bulk = (1..199).flatMap { stop -> (1..3).map { order -> "B$stop-$order" to "대형 거래처 $stop" } }
        val full = (1..3).joinToString(",") {
            """{"sku":"S$it","name":"품목 $it 상세 이름","qty":$it,"boxes":1,"barcode":"88012345678$it"}"""
        }
        val access = """"access":{"entranceCode":"1234*","placeNote":"뒷문 냉장고 앞"}"""
        val extras = bulk.associate { (id, _) -> id to """"items":[$full],"csNote":"요청 사항 메모",$access""" }
        val f = routeFixture(directory, extras = extras, bulk = bulk)
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("stops").size()).isEqualTo(202)
        val bytes = driverJson.writeValueAsBytes(route).size
        assertThat(bytes).isLessThan(1024 * 1024)
        assertThat(bytes).isGreaterThan(100_000)
    }
}
