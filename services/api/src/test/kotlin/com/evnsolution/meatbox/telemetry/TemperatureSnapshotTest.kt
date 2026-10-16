package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.DispatchController
import com.evnsolution.meatbox.dispatch.TemperatureSource
import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.RouteFixture
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.ops.quietAlerts
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.mock.web.MockHttpServletRequest
import java.nio.file.Path
import java.time.Instant

class TemperatureSnapshotTest {
    @TempDir lateinit var directory: Path

    private val fixture: RouteFixture by lazy { routeFixture(directory) }
    private val clock = { Instant.ofEpochMilli(fixture.now.get()) }
    private val store by lazy { TemperatureStore(directory.toRealPath().resolve("telemetry"), clock) }
    private val watch by lazy {
        val ranges = TemperatureRanges(directory.toRealPath().resolve("telemetry/ranges.json"), null)
        TemperatureWatch(store, ranges, quietAlerts()).also {
            fixture.dispatch.temperatures = TemperatureSource(it::perVehicle)
        }
    }

    private fun send(vehicle: String, celsius: Double, secondsAgo: Long = 60, compartment: String? = "frozen") {
        val at = clock().minusSeconds(secondsAgo)
        val batch = Batch(vehicle, "S-1", listOf(Reading("S-1", at, celsius, compartment)))
        watch.observe(vehicle, store.ingest(batch).fresh)
    }

    private fun etag() = DispatchController(fixture.dispatch, "http://127.0.0.1:4173")
        .state(DRIVER_DATE, MockHttpServletRequest()).headers.eTag

    @Test
    fun `a snapshot without telemetry is the same as before`() {
        val before = fixture.dispatch.snapshot(DRIVER_DATE).toString()
        val tag = etag()
        watch
        send("OTHER", -18.0)

        assertThat(fixture.dispatch.snapshot(DRIVER_DATE).toString()).isEqualTo(before)
        assertThat(etag()).isEqualTo(tag)
        assertThat(before).doesNotContain("temperature")
    }

    @Test
    fun `today's snapshot shows the newest temperature and its ETag follows every change`() {
        watch
        val tagBefore = etag()
        send("G1", -18.4)

        val snapshot = fixture.dispatch.snapshot(DRIVER_DATE)
        val shown = snapshot.path("vehicleStates").path("G1").path("temperature")
        assertThat(shown.path("celsius").doubleValue()).isEqualTo(-18.4)
        assertThat(shown.path("measuredAt").asString()).isEqualTo("2026-10-13T09:59:00+09:00")
        assertThat(shown.path("stale").asBoolean()).isFalse()
        assertThat(shown.path("outOfRange").asBoolean()).isFalse()
        assertThat(snapshot.path("vehicleStates").path("G2").has("temperature")).isFalse()
        val tagShown = etag()
        assertThat(tagShown).isNotEqualTo(tagBefore).contains("-t")

        fixture.now.addAndGet(11 * 60 * 1000L)
        val stale = fixture.dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").path("temperature")
        assertThat(stale.path("stale").asBoolean()).isTrue()
        assertThat(etag()).isNotEqualTo(tagShown)
    }

    @Test
    fun `marks a confirmed excursion and gives the driver route the same value`() {
        watch
        repeat(3) { send("G1", -10.0, secondsAgo = 120L - it * 30) }

        val route = fixture.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("temperature").path("outOfRange").asBoolean()).isTrue()
        assertThat(route.path("temperature").path("celsius").doubleValue()).isEqualTo(-10.0)
        assertThat(fixture.driver.queries.route(DRIVER_DATE, "G2").has("temperature")).isFalse()
    }

    @Test
    fun `another date does not show today's temperature`() {
        watch
        send("G1", -18.0)
        assertThat(fixture.dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").has("temperature")).isTrue()

        fixture.now.addAndGet(24 * 60 * 60 * 1000L)
        assertThat(fixture.dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").has("temperature")).isFalse()
    }
}
