package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.MockEngine
import com.evnsolution.meatbox.eta.VroomOptimizer
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

/** The suggested order with VROOM behind the driver store. */
class DriverVroomOrderTest {
    @TempDir lateinit var directory: Path

    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val depot = EtaPoint(37.5, 127.0)

    // Current order O1 (far), O3 (near), O4 (middle). The nearest-first order is O3, O4, O1.
    private val places = mapOf("O1" to "[127.20,37.5]", "O3" to "[127.01,37.5]", "O4" to "[127.10,37.5]")
    private val rank = listOf(127.10, 127.01, 127.20) // VROOM's answer in this test: O4, O3, O1

    private val engine = MockEngine { request ->
        MockEngine.vroom(request) { jobs -> jobs.sortedBy { rank.indexOf(it.second.lng) }.map { it.first } }
    }

    @AfterEach
    fun stop() = engine.close()

    private fun open(name: String, vroom: Boolean, coordinates: Map<String, String> = places): RouteFixture {
        val root = Files.createDirectories(directory.resolve(name))
        val optimizer = if (vroom) VroomOptimizer(engine.url, ErrorAlerts(channel, "test", executor)) else null
        return routeFixture(root, coordinates, depot = depot, optimizer = optimizer)
    }

    private fun RouteFixture.suggest(lockFirst: String? = null) = driver.queries.suggest(DRIVER_DATE, "G1", lockFirst)

    private fun ObjectNode.order() = path("stopOrder").toList().map { it.asString() }

    private fun requestBody() = JsonMapper.builder().build().readTree(engine.requests.last().body)

    @Test
    fun `the suggested order is the one VROOM answers`() {
        val suggestion = open("vroom", true).suggest()
        assertThat(suggestion.order()).containsExactly("O4", "O3", "O1")
        assertThat(suggestion.path("engine").asString()).isEqualTo("vroom")
        assertThat(suggestion.path("changed").asBoolean()).isTrue()
        assertThat(open("plain", false).suggest().order()).containsExactly("O3", "O4", "O1")
    }

    @Test
    fun `after the departure the closed and current stops stay and VROOM only sees the pending ones`() {
        val f = open("vroom", true)
        f.driver.activity.acceptEvent(
            DRIVER_DATE,
            driverJson.readTree(
                """{"eventId":"go","type":"departed","occurredAt":"2026-10-13T10:00:00+09:00","date":"$DRIVER_DATE",
                "vehicleId":"G1","payload":{}}""",
            ) as ObjectNode,
        )
        val suggestion = f.suggest()
        assertThat(suggestion.order()).containsExactly("O1", "O4", "O3")
        assertThat(requestBody().path("jobs")).hasSize(2)
    }

    @Test
    fun `lockFirst starts the vehicle at that stop`() {
        val suggestion = open("vroom", true).suggest("O3")
        assertThat(suggestion.order().first()).isEqualTo("O3")
        assertThat(requestBody().path("vehicles")[0].path("start").toString()).isEqualTo("[127.01,37.5]")
    }

    @Test
    fun `a stop without coordinates is not sent to VROOM and is placed after the order`() {
        val suggestion = open("vroom", true, places + ("O4" to "null")).suggest()
        assertThat(requestBody().path("jobs")).hasSize(2)
        assertThat(suggestion.order()).hasSize(3).contains("O4")
        assertThat(suggestion.path("placed").single().path("stopId").asString()).isEqualTo("O4")
    }

    @Test
    fun `a VROOM error gives the 2-opt order, says haversine and alerts once`() {
        engine.handler = { MockEngine.Reply(503, "down") }
        val f = open("vroom", true)
        val suggestion = f.suggest()
        f.suggest()
        executor.drain()
        assertThat(suggestion.order()).containsExactly("O3", "O4", "O1")
        assertThat(suggestion.path("engine").asString()).isEqualTo("haversine")
        assertThat(channel.sent.map { it.first }).containsExactly("[meatbox-tms] route-engine VROOM_UNAVAILABLE")
        assertThat(engine.requests).hasSize(1)
    }
}
