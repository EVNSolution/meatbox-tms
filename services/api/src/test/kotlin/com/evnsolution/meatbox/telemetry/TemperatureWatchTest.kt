package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

class TemperatureWatchTest {
    @TempDir lateinit var directory: Path

    private val now = AtomicReference(Instant.parse("2026-10-16T01:00:00Z"))
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val alerts = ErrorAlerts(channel, "test", executor, now::get)
    private var invalid = 0
    private val root: Path by lazy { directory.toRealPath().resolve("telemetry") }
    private val store by lazy { TemperatureStore(root, now::get) }
    private val ranges by lazy { TemperatureRanges(root.resolve("ranges.json"), null) { invalid++ } }
    private val watch by lazy { TemperatureWatch(store, ranges, alerts) }
    private var minute = 0L

    private fun send(
        celsius: Double,
        vehicle: String = "V-1",
        compartment: String? = "frozen",
        sensor: String = "S-1",
    ) {
        val at = now.get().minusSeconds(600).plusSeconds(minute++ * 30)
        val batch = Batch(vehicle, sensor, listOf(Reading(sensor, at, celsius, compartment)))
        watch.observe(vehicle, store.ingest(batch).fresh)
    }

    private fun sent(): List<String> {
        executor.drain()
        return channel.sent.map { it.first }.filter { it.contains("OUT_OF_RANGE") }
    }

    private fun writeRanges(text: String, modified: Long) {
        Files.createDirectories(root)
        Files.writeString(root.resolve("ranges.json"), text)
        Files.setLastModifiedTime(root.resolve("ranges.json"), FileTime.fromMillis(modified))
    }

    @Test
    fun `alerts once when three readings in a row leave the range and not for a single spike`() {
        send(-10.0)
        send(-10.0)
        send(-19.0)
        send(-10.0)
        send(-10.0)
        assertThat(sent()).isEmpty()
        assertThat(store.latest().single().let(watch::outOfRange)).isFalse()

        send(-10.0)
        assertThat(sent()).hasSize(1)
        assertThat(store.latest().single().let(watch::outOfRange)).isTrue()
        assertThat(channel.sent.single().second).contains("vehicleId=V-1").contains("celsius=-10.0")
        send(-9.0)
        assertThat(sent()).hasSize(1)

        send(-20.0)
        assertThat(store.latest().single().let(watch::outOfRange)).isFalse()
    }

    @Test
    fun `a second leaving inside the alert window is suppressed by the alert window and counted`() {
        repeat(3) { send(-10.0) }
        send(-20.0)
        repeat(3) { send(-10.0) }

        assertThat(sent()).hasSize(1)
        assertThat(alerts.recent()).hasSize(1)
    }

    @Test
    fun `chooses the range from the compartment, then the vehicle entry, then the default kind`() {
        writeRanges("""{"V-1":{"kind":"chilled"},"V-2":{"min":-2,"max":2}}""", 1_000)
        send(4.0, vehicle = "V-1", compartment = null)
        send(4.0, vehicle = "V-2", compartment = null)
        send(8.0, vehicle = "V-1", compartment = "frozen")
        send(8.0, vehicle = "V-9", compartment = null)

        val byVehicle = watch.perVehicle()
        assertThat(ranges.of("V-1", null)!!.let { it.min to it.max }).isEqualTo(0.0 to 5.0)
        assertThat(ranges.of("V-2", null)!!.let { it.min to it.max }).isEqualTo(-2.0 to 2.0)
        assertThat(ranges.of("V-9", null)).isNull()
        assertThat(TemperatureRanges(root.resolve("none.json"), "frozen").of("V-9", null)!!.max).isEqualTo(-18.0)
        assertThat(byVehicle.keys).containsExactlyInAnyOrder("V-1", "V-2", "V-9")
    }

    @Test
    fun `never judges a vehicle that has no range`() {
        repeat(5) { send(30.0, vehicle = "V-9", compartment = null) }

        assertThat(sent()).isEmpty()
        assertThat(watch.perVehicle().getValue("V-9").outOfRange).isFalse()
    }

    @Test
    fun `reads the file again when it changes and reports a broken file once`() {
        writeRanges("""{"V-1":{"kind":"frozen"}}""", 1_000)
        assertThat(ranges.of("V-1", null)!!.max).isEqualTo(-18.0)

        writeRanges("""{"V-1":{"min":0,"max":5}}""", 2_000)
        assertThat(ranges.of("V-1", null)!!.min).isEqualTo(0.0)

        writeRanges("""{"V-1":{"kind":"warm"}}""", 3_000)
        assertThat(ranges.of("V-1", null)).isNull()
        assertThat(ranges.of("V-1", null)).isNull()
        assertThat(invalid).isEqualTo(1)
        listOf("""[]""", """{"../x":{"kind":"frozen"}}""", """{"V-1":{}}""", """{"V-1":{"min":5,"max":0}}""")
            .forEachIndexed { index, text ->
                writeRanges(text, 4_000L + index * 1_000)
                assertThat(ranges.of("V-1", null)).describedAs(text).isNull()
            }
        assertThat(invalid).isEqualTo(5)
    }

    @Test
    fun `readings older than the stale window do not change the state`() {
        val old = now.get().minusSeconds(3_600)
        repeat(3) {
            val batch = Batch("V-1", "S-1", listOf(Reading("S-1", old.plusSeconds(it * 30L), -10.0, "frozen")))
            watch.observe("V-1", store.ingest(batch).fresh)
        }

        assertThat(sent()).isEmpty()
    }

    @Test
    fun `shows the newest sensor and goes stale only when every sensor is silent`() {
        send(-18.0, sensor = "S-1")
        now.set(now.get().plusSeconds(500))
        send(-17.0, sensor = "S-2")
        now.set(now.get().plusSeconds(200))

        val vehicle = watch.perVehicle().getValue("V-1")
        assertThat(vehicle.celsius).isEqualTo(-17.0)
        assertThat(vehicle.stale).isFalse()
        now.set(now.get().plusSeconds(600))
        assertThat(watch.perVehicle().getValue("V-1").stale).isTrue()
    }
}
