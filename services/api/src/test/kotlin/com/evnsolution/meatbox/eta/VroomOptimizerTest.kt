package com.evnsolution.meatbox.eta

import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import java.time.Duration
import java.time.Instant

class VroomOptimizerTest {
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val alerts = ErrorAlerts(channel, "test", executor)
    private val engine = MockEngine { request ->
        MockEngine.vroom(request) { jobs -> jobs.sortedByDescending { it.second.lng }.map { it.first } }
    }
    private var clock = Instant.parse("2026-10-17T00:00:00Z")

    private fun stop(id: String, lng: Double) = PlanStop(id, "주소 $id", EtaPoint(37.5, lng), false)

    private val stops = listOf(stop("A", 127.1), stop("B", 127.3), stop("C", 127.2))
    private val depot = EtaPoint(37.5, 127.0)

    private fun optimizer(timeout: Duration = Duration.ofSeconds(3)) =
        VroomOptimizer(engine.url, alerts, timeout) { clock }

    @AfterEach
    fun stop() = engine.close()

    @Test
    fun `sends one vehicle at the origin and one job per stop and returns the answered order`() {
        assertThat(optimizer().order(stops, depot, null)).containsExactly("B", "C", "A")
        val body = JsonMapper.builder().build().readTree(engine.requests.single().body)
        assertThat(engine.requests.single().method).isEqualTo("POST")
        assertThat(body.path("vehicles")).hasSize(1)
        assertThat(body.path("vehicles")[0].path("start").toString()).isEqualTo("[127.0,37.5]")
        assertThat(body.path("vehicles")[0].has("end")).isFalse()
        assertThat(body.path("jobs")).hasSize(3)
        assertThat(body.path("options").path("g").asBoolean(true)).isFalse()
    }

    @Test
    fun `the first stop leads the answer and is the vehicle start instead of a job`() {
        assertThat(optimizer().order(stops, depot, "A")).containsExactly("A", "B", "C")
        val body = JsonMapper.builder().build().readTree(engine.requests.single().body)
        assertThat(body.path("vehicles")[0].path("start").toString()).isEqualTo("[127.1,37.5]")
        assertThat(body.path("jobs")).hasSize(2)
    }

    @Test
    fun `an engine error, a slow engine and an incomplete answer return null and alert once`() {
        engine.handler = { MockEngine.Reply(503, "down") }
        assertThat(optimizer().order(stops, depot, null)).isNull()
        assertThat(optimizer().order(stops, depot, null)).isNull()
        engine.handler = { MockEngine.Reply(body = "{}", delayMillis = 1500) }
        val slow = optimizer(Duration.ofMillis(300))
        assertThat(slow.order(stops, depot, null)).isNull()
        engine.handler = { MockEngine.vroom(it) { jobs -> jobs.take(1).map { j -> j.first } } }
        assertThat(optimizer().order(stops, depot, null)).isNull()
        executor.drain()
        assertThat(channel.sent.map { it.first }).containsExactly("[meatbox-tms] route-engine VROOM_UNAVAILABLE")
    }

    @Test
    fun `a stop that no road reaches is not an outage, so no alert and no pause`() {
        engine.handler = { MockEngine.Reply(500, """{"code":3,"error":"Could not find route near location"}""") }
        val vroom = optimizer()
        assertThat(vroom.order(stops, depot, null)).isNull()
        assertThat(vroom.order(stops, depot, null)).isNull()
        executor.drain()
        assertThat(engine.requests).hasSize(2)
        assertThat(channel.sent).isEmpty()
    }

    @Test
    fun `after a failure the engine is left alone for thirty seconds`() {
        engine.handler = { MockEngine.Reply(503, "down") }
        val vroom = optimizer()
        assertThat(vroom.order(stops, depot, null)).isNull()
        assertThat(vroom.order(stops, depot, null)).isNull()
        assertThat(engine.requests).hasSize(1)
        clock = clock.plusSeconds(31)
        engine.handler = { MockEngine.vroom(it) { jobs -> jobs.map { j -> j.first } } }
        assertThat(vroom.order(stops, depot, null)).containsExactly("A", "B", "C")
    }

    @Test
    fun `more than 200 stops never reach the engine`() {
        val many = (0..200).map { stop("S$it", 127.0 + it * 0.001) }
        assertThat(optimizer().order(many, depot, null)).isNull()
        assertThat(engine.requests).isEmpty()
        assertThat(optimizer().order(many.take(200), depot, null)).hasSize(200)
    }
}
