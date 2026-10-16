package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.eta.EtaPoint
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path

class DashboardTest {
    @TempDir lateinit var directory: Path

    private fun dashboard(f: RouteFixture, rulesJson: String? = null, assigned: String? = null): Dashboard {
        val rules = f.state.resolve("incentive-rules.json")
        rulesJson?.let { Files.writeString(rules, it) }
        val owners = DriverAssignments(f.state.resolve("driver-assignments.json"))
        assigned?.let { owners.assign(0, "G1", it) }
        return Dashboard(f.driver, owners, IncentiveRulesFile(rules))
    }

    private fun RouteFixture.send(id: String, type: String, payload: String) = driver.activity.acceptEvent(
        DRIVER_DATE,
        driverJson.readTree(
            """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
        ) as ObjectNode,
    )

    private fun RouteFixture.runDay() {
        send("go", "departed", "{}")
        for ((id, stop) in listOf("a" to "O1", "b" to "O3", "c" to "O4")) {
            now.addAndGet(600_000)
            send(id, "stop_completed", """{"stopId":"$stop"}""")
        }
    }

    @Test
    fun `a finished day gives stops, boxes, times, the estimated distance and the per-stop figures`() {
        val f = routeFixture(directory, depot = EtaPoint(37.5, 127.0))
        f.runDay()
        val day = dashboard(f).range(DRIVER_DATE, DRIVER_DATE).path("days").first()
        assertThat(day.path("phase").asString()).isEqualTo("published")
        assertThat(day.path("orders").asInt()).isEqualTo(4)
        assertThat(day.path("boxes").asDouble()).isEqualTo(4.0)
        assertThat(day.path("stops").asInt()).isEqualTo(3)
        val vehicle = day.path("vehicles").first()
        assertThat(vehicle.path("vehicleId").asString()).isEqualTo("G1")
        assertThat(vehicle.path("stops").asInt()).isEqualTo(3)
        assertThat(vehicle.path("stopsDone").asInt()).isEqualTo(3)
        assertThat(vehicle.path("boxesDelivered").asDouble()).isEqualTo(4.0)
        assertThat(vehicle.path("driveMinutes").asDouble()).isEqualTo(30.0)
        assertThat(vehicle.path("minutesPerStop").asDouble()).isEqualTo(10.0)
        assertThat(vehicle.path("boxesPerStop").asDouble()).isEqualTo(1.3)
        assertThat(vehicle.path("departedAt").asString()).endsWith("+09:00")
        assertThat(vehicle.path("distanceBasis").asString()).isEqualTo("estimate")
        assertThat(vehicle.path("actualKm").isNull).isTrue()
        assertThat(day.path("zones").first().path("zoneId").asString()).isEqualTo("Z1")
        assertThat(day.path("unlocatedOrders").asInt()).isZero()
        assertThat(day.has("incentive")).isFalse()
    }

    @Test
    fun `a day that is still running has no drive time and a vehicle without coordinates has no distance`() {
        val none = listOf("O1", "O2", "O3", "O4").associateWith { "null" }
        val f = routeFixture(directory, coordinates = none)
        f.send("go", "departed", "{}")
        val vehicle = dashboard(f).range(DRIVER_DATE, DRIVER_DATE).path("days").first().path("vehicles").first()
        assertThat(vehicle.path("driveMinutes").isNull).isTrue()
        assertThat(vehicle.path("finishedAt").isNull).isTrue()
        assertThat(vehicle.path("distanceKm").isNull).isTrue()
        assertThat(vehicle.path("stopsDone").asInt()).isZero()
    }

    @Test
    fun `the extra fee counts the amount above the target, with a driver's own target winning`() {
        val f = routeFixture(directory)
        f.runDay()
        val rules = """{"unit":"boxes","dailyTarget":2,"ratePerUnit":500,"targetsByDriver":{"kim":3}}"""
        val plain = dashboard(f, rules).range(DRIVER_DATE, DRIVER_DATE)
        assertThat(plain.path("incentiveRules").path("unit").asString()).isEqualTo("boxes")
        val day = plain.path("days").first()
        assertThat(day.path("vehicles").first().path("incentive").path("amount").asLong()).isEqualTo(1000)
        assertThat(day.path("incentive").path("people").asInt()).isEqualTo(1)
        assertThat(day.path("incentive").path("amount").asLong()).isEqualTo(1000)
        val own = dashboard(f, rules, assigned = "kim").range(DRIVER_DATE, DRIVER_DATE).path("days").first()
        assertThat(own.path("vehicles").first().path("incentive").path("target").asDouble()).isEqualTo(3.0)
        assertThat(own.path("incentive").path("amount").asLong()).isEqualTo(500)
    }

    @Test
    fun `no rule file shows no fee and an invalid one is named instead of read as zero`() {
        val f = routeFixture(directory)
        f.runDay()
        val none = dashboard(f).range(DRIVER_DATE, DRIVER_DATE)
        assertThat(none.path("incentiveRules").isNull).isTrue()
        assertThat(none.has("incentiveRulesError")).isFalse()
        val invalid = listOf(
            "{", """{"unit":"kg","dailyTarget":1,"ratePerUnit":1}""",
            """{"unit":"boxes","dailyTarget":-1,"ratePerUnit":1}""",
            """{"unit":"boxes","dailyTarget":1,"ratePerUnit":1,"targetsByDriver":{"kim":"x"}}""",
        )
        for (bad in invalid) {
            val broken = dashboard(f, bad).range(DRIVER_DATE, DRIVER_DATE)
            assertThat(broken.path("incentiveRulesError").asString()).isEqualTo("INCENTIVE_RULES_INVALID")
            assertThat(broken.path("days").first().has("incentive")).isFalse()
        }
    }

    @Test
    fun `a range is checked and limited to 31 days, and dates without orders are left out`() {
        val f = routeFixture(directory)
        val board = dashboard(f)
        fun code(from: String, to: String) = assertThatThrownBy { board.range(from, to) }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.code).isNotBlank() }
        code("2026-02-30", "2026-03-01")
        code("2026-10-14", "2026-10-13")
        code("2026-09-01", "2026-10-02")
        assertThat(board.range("2026-10-01", "2026-10-31").path("days").size()).isEqualTo(1)
        assertThat(board.range("2026-09-30", "2026-10-30").path("days").size()).isEqualTo(1)
    }
}
