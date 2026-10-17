package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.HaversineEstimator
import com.evnsolution.meatbox.eta.MockEngine
import com.evnsolution.meatbox.eta.OsrmTableEstimator
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.OffsetDateTime

/** The road engine behind the driver store: the stored ETA and the suggested order's engine and kilometres. */
class DriverRoadEngineTest {
    @TempDir lateinit var directory: Path

    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val engine = MockEngine { MockEngine.table(it.uri) }

    // O1 (far), O3 (near), O4 (middle) on one latitude; O2 shares O1's destination.
    private val places = mapOf("O1" to "[127.20,37.5]", "O3" to "[127.01,37.5]", "O4" to "[127.10,37.5]")
    private val depot = EtaPoint(37.5, 127.0)

    @AfterEach
    fun stop() = engine.close()

    private fun fixture(name: String, road: Boolean): RouteFixture {
        val estimator = if (road) {
            OsrmTableEstimator(engine.url, HaversineEstimator(EtaConfig()), ErrorAlerts(channel, "test", executor))
        } else {
            null
        }
        val root = Files.createDirectories(directory.resolve(name))
        return routeFixture(root, places, depot = depot, estimator = estimator)
    }

    private fun RouteFixture.depart() = driver.activity.acceptEvent(
        DRIVER_DATE,
        driverJson.readTree(
            """{"eventId":"go","type":"departed","occurredAt":"2026-10-13T10:00:00+09:00","date":"$DRIVER_DATE",
            "vehicleId":"G1","payload":{},"location":{"lat":37.5,"lng":127.0,"accuracyM":8}}""",
        ) as ObjectNode,
    )

    private fun RouteFixture.eta() = dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").path("eta")

    private fun JsonNode.etaTimes() = path("stops").toList().map { it.path("eta").asString() }

    @Test
    fun `the departure eta follows the road table and says so`() {
        val f = fixture("road", true)
        f.depart()
        assertThat(f.eta().path("engine").asString()).isEqualTo("osrm")
        // O1 is the first stop: 0.2 degrees = 2000 s on the table (33 min) against 25 min on straight lines.
        val first = OffsetDateTime.parse(f.eta().path("stops")[0].path("eta").asString())
        assertThat(Duration.between(OffsetDateTime.parse("2026-10-13T10:00:00+09:00"), first).toMinutes()).isEqualTo(33)
        val plain = fixture("plain", false)
        plain.depart()
        assertThat(plain.eta().etaTimes()).isNotEqualTo(f.eta().etaTimes())
    }

    @Test
    fun `without an engine nothing about the engine is stored or answered`() {
        val f = fixture("plain", false)
        f.depart()
        assertThat(f.eta().has("engine")).isFalse()
        assertThat(f.driver.queries.suggest(DRIVER_DATE, "G1", null).has("engine")).isFalse()
    }

    @Test
    fun `an engine that fails leaves the straight line eta, marks it and alerts once`() {
        val plain = fixture("plain", false).also { it.depart() }
        engine.handler = { MockEngine.Reply(503, "down") }
        val f = fixture("down", true)
        f.depart()
        f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        executor.drain()
        assertThat(f.eta().path("engine").asString()).isEqualTo("haversine")
        assertThat(f.eta().etaTimes()).isEqualTo(plain.eta().etaTimes())
        assertThat(channel.sent.map { it.first }).containsExactly("[meatbox-tms] route-engine OSRM_UNAVAILABLE")
    }

    @Test
    fun `the suggestion reports the engine and the road kilometres`() {
        val suggestion = fixture("road", true).driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(suggestion.path("engine").asString()).isEqualTo("osrm")
        assertThat(suggestion.path("stopOrder").toList().map { it.asString() }).containsExactly("O3", "O4", "O1")
        // Depot to the far stop is 0.2 degrees = 20 km on the table.
        assertThat(suggestion.path("totalKm").asDouble()).isEqualTo(20.0)
    }

    @Test
    fun `the dashboard distance is the road plan when the engine answers and the estimate when it does not`() {
        fun vehicle(f: RouteFixture): JsonNode {
            val owners = DriverAssignments(f.state.resolve("driver-assignments.json"))
            val dashboard = Dashboard(f.driver, owners, IncentiveRulesFile(f.state.resolve("incentive-rules.json")))
            return dashboard.range(DRIVER_DATE, DRIVER_DATE).path("days").first().path("vehicles").first()
        }
        val road = vehicle(fixture("road", true))
        // Depot 127.00 -> O1 127.20 -> O3 127.01 -> O4 127.10: 20 + 19 + 9 km on the table.
        assertThat(road.path("distanceBasis").asString()).isEqualTo("road-plan")
        assertThat(road.path("distanceKm").asDouble()).isEqualTo(48.0)
        engine.handler = { MockEngine.Reply(503, "down") }
        val down = vehicle(fixture("down", true))
        assertThat(down.path("distanceBasis").asString()).isEqualTo("estimate")
        val plain = vehicle(fixture("plain", false))
        assertThat(plain.path("distanceKm").asDouble()).isEqualTo(down.path("distanceKm").asDouble())
    }
}
