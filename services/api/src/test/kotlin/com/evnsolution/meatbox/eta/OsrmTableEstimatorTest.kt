package com.evnsolution.meatbox.eta

import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.time.Duration
import java.time.Instant

class OsrmTableEstimatorTest {
    private val haversine = HaversineEstimator(EtaConfig())
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val alerts = ErrorAlerts(channel, "test", executor)
    private val engine = MockEngine { MockEngine.table(it.uri) }
    private var clock = Instant.parse("2026-10-17T00:00:00Z")

    private val a = EtaPoint(37.5, 127.0)
    private val b = EtaPoint(37.5, 127.1)
    private val c = EtaPoint(37.5, 127.3)

    private fun estimator(timeout: Duration = Duration.ofSeconds(3), url: String = engine.url) =
        OsrmTableEstimator(url, haversine, alerts, timeout) { clock }

    @AfterEach
    fun stop() = engine.close()

    @Test
    fun `one table request answers every leg and the second prepare is served from the cache`() {
        val osrm = estimator()
        assertThat(osrm.prepare(listOf(a, b, c, b))).isEqualTo("osrm")
        assertThat(osrm.seconds(a, b)).isEqualTo(1000)
        assertThat(osrm.seconds(a, c)).isEqualTo(3000)
        assertThat(osrm.meters(b, c)).isEqualTo(20_000)
        assertThat(osrm.seconds(a, b)).isNotEqualTo(haversine.seconds(a, b))

        assertThat(engine.requests).hasSize(1)
        val request = engine.requests.single()
        assertThat(request.method).isEqualTo("GET")
        assertThat(request.uri).startsWith("/table/v1/car/").contains("annotations=duration,distance")
        assertThat(MockEngine.coordinates(request.uri)).containsExactlyInAnyOrder(a, b, c)

        assertThat(osrm.prepare(listOf(c, b, a))).isEqualTo("osrm")
        assertThat(engine.requests).hasSize(1)
        clock = clock.plusSeconds(61)
        assertThat(osrm.prepare(listOf(a, b, c))).isEqualTo("osrm")
        assertThat(engine.requests).hasSize(2)
    }

    @Test
    fun `the eta model computes the arrivals from the table values`() {
        val osrm = estimator()
        val model = EtaModel(EtaConfig(serviceMinutes = 0), osrm)
        val departure = Instant.parse("2026-10-17T01:00:00Z")
        val result = model.compute(listOf(EtaStopInput("A", b), EtaStopInput("B", c)), departure, a)
        // 1000 s rounds to 17 min.
        assertThat(Duration.between(departure, result[0].eta)).isEqualTo(Duration.ofSeconds(1020))
        assertThat(Duration.between(departure, result[1].eta)).isEqualTo(Duration.ofSeconds(3000))
        assertThat(model.engine(listOf(EtaStopInput("A", b)), a)).isEqualTo("osrm")
    }

    @Test
    fun `an engine error falls back to the straight line model, alerts once and is not asked again at once`() {
        engine.handler = { MockEngine.Reply(503, "down") }
        val osrm = estimator()
        assertThat(osrm.prepare(listOf(a, b))).isEqualTo("haversine")
        assertThat(osrm.seconds(a, b)).isEqualTo(haversine.seconds(a, b))
        assertThat(osrm.meters(a, b)).isNull()
        assertThat(osrm.prepare(listOf(a, c))).isEqualTo("haversine")
        executor.drain()
        assertThat(engine.requests).hasSize(1)
        assertThat(channel.sent.map { it.first }).containsExactly("[meatbox-tms] route-engine OSRM_UNAVAILABLE")
        clock = clock.plusSeconds(31)
        osrm.prepare(listOf(a, c))
        assertThat(engine.requests).hasSize(2)
    }

    @Test
    fun `a slow engine is cut off after the timeout`() {
        engine.handler = { MockEngine.Reply(body = "{}", delayMillis = 1500) }
        val osrm = estimator(timeout = Duration.ofMillis(300))
        val started = System.nanoTime()
        assertThat(osrm.prepare(listOf(a, b))).isEqualTo("haversine")
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1))
        executor.drain()
        assertThat(channel.sent).hasSize(1)
    }

    @Test
    fun `an engine that is not listening and a bad answer both fall back`() {
        val closed = MockEngine { MockEngine.Reply() }.also { it.close() }
        assertThat(estimator(url = closed.url).prepare(listOf(a, b))).isEqualTo("haversine")
        engine.handler = { MockEngine.Reply(body = """{"code":"NoTable"}""") }
        assertThat(estimator().prepare(listOf(a, b))).isEqualTo("haversine")
        executor.drain()
        assertThat(channel.sent).hasSize(1) // one alert per ten minutes for the same code
    }

    @Test
    fun `more than 200 points never reach the engine`() {
        val many = (0..200).map { EtaPoint(37.5, 127.0 + it * 0.001) }
        val osrm = estimator()
        assertThat(osrm.prepare(many)).isEqualTo("haversine")
        assertThat(osrm.seconds(many[0], many[1])).isEqualTo(haversine.seconds(many[0], many[1]))
        assertThat(engine.requests).isEmpty()
        assertThat(osrm.prepare(many.take(200))).isEqualTo("osrm")
        assertThat(osrm.prepare(listOf(a))).isNull()
    }
}
