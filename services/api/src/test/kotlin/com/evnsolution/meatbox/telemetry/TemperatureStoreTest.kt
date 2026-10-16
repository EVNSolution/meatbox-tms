package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

class TemperatureStoreTest {
    @TempDir lateinit var directory: Path

    private val now = AtomicReference(Instant.parse("2026-10-16T01:00:00Z"))
    private val json = JsonMapper.builder().build()
    private val real: Path by lazy { directory.toRealPath() }

    private fun store(root: Path = real.resolve("telemetry")) = TemperatureStore(root, now::get)

    private fun batch(vararg readings: Pair<String, Double>, vehicle: String = "V-1", sensor: String = "S-1") =
        Batch(vehicle, sensor, readings.map { (at, celsius) -> Reading(sensor, Instant.parse(at), celsius, null) })

    private fun body(measurements: String, extra: String = "") =
        json.readTree("""{"vehicleId":"V-1","sensorId":"S-1","measurements":$measurements$extra}""") as ObjectNode

    private fun codeOf(block: () -> Unit) = (catchThrowable(block) as DispatchException).code

    private fun catchThrowable(block: () -> Unit): Throwable = assertThatThrownBy { block() }.actual()

    @Test
    fun `stores a measurement as one line in the file of its Seoul day and answers latest`() {
        val store = store()
        val receipt = store.ingest(batch("2026-10-16T00:59:30Z" to -18.4, "2026-10-16T00:59:00Z" to -18.1))

        assertThat(receipt.accepted).isEqualTo(2)
        val file = real.resolve("telemetry/V-1/2026-10-16.jsonl")
        val lines = Files.readAllLines(file).map { json.readTree(it) }
        assertThat(lines.map { it.path("t").asString() })
            .containsExactly("2026-10-16T09:59:30+09:00", "2026-10-16T09:59:00+09:00")
        assertThat(lines[0].path("c").doubleValue()).isEqualTo(-18.4)
        assertThat(lines[0].path("s").asString()).isEqualTo("S-1")
        assertThat(lines[0].path("r").asLong()).isEqualTo(now.get().toEpochMilli())
        val latest = store.latest().single()
        assertThat(latest.celsius).isEqualTo(-18.4)
        assertThat(latest.measuredAt).isEqualTo(Instant.parse("2026-10-16T00:59:30Z"))
        assertThat(Files.getPosixFilePermissions(file).map { it.name })
            .containsExactlyInAnyOrder("OWNER_READ", "OWNER_WRITE")
    }

    @Test
    fun `ignores a repeated sensor and second and files a measurement under its own day`() {
        val store = store()
        store.ingest(batch("2026-10-16T14:59:59Z" to -18.0))
        val again = store.ingest(
            batch("2026-10-16T14:59:59Z" to -17.0, "2026-10-16T15:00:00Z" to -18.2, "2026-10-16T15:00:00Z" to -9.0),
        )

        assertThat(again.accepted).isEqualTo(1)
        assertThat(again.duplicate).isEqualTo(2)
        assertThat(Files.readAllLines(real.resolve("telemetry/V-1/2026-10-16.jsonl"))).hasSize(1)
        assertThat(Files.readAllLines(real.resolve("telemetry/V-1/2026-10-17.jsonl"))).hasSize(1)
        assertThat(store.ingest(batch("2026-10-16T15:00:00Z" to -18.2)).accepted).isZero()
    }

    @Test
    fun `an older measurement does not replace the latest value but a repeat batch is not new data`() {
        val store = store()
        store.ingest(batch("2026-10-16T00:50:00Z" to -18.0))
        now.set(now.get().plusSeconds(60))
        store.ingest(batch("2026-10-16T00:40:00Z" to -5.0))

        val latest = store.latest().single()
        assertThat(latest.celsius).isEqualTo(-18.0)
        assertThat(latest.receivedAt).isEqualTo(now.get())
        now.set(now.get().plusSeconds(60))
        store.ingest(batch("2026-10-16T00:40:00Z" to -5.0))
        assertThat(store.latest().single().receivedAt).isEqualTo(now.get().minusSeconds(60))
    }

    @Test
    fun `finds repeats that another process appended and cuts a half written last line`() {
        val root = real.resolve("telemetry")
        val first = store(root)
        first.ingest(batch("2026-10-16T00:00:00Z" to -18.0))
        val other = store(root)
        other.ingest(batch("2026-10-16T00:00:30Z" to -18.1))

        val mixed = batch("2026-10-16T00:00:30Z" to -18.1, "2026-10-16T00:01:00Z" to -18.2)
        assertThat(first.ingest(mixed).accepted).isEqualTo(1)

        val file = root.resolve("V-1/2026-10-16.jsonl")
        Files.write(file, Files.readAllBytes(file) + """{"t":"2026-10-16T09:02""".toByteArray())
        val after = store(root).ingest(batch("2026-10-16T00:02:00Z" to -18.3))
        assertThat(after.accepted).isEqualTo(1)
        assertThat(Files.readAllLines(file).map { json.readTree(it).path("c").doubleValue() })
            .containsExactly(-18.0, -18.1, -18.2, -18.3)
    }

    @Test
    fun `a new process knows the newest value of each sensor again`() {
        val root = real.resolve("telemetry")
        store(root).ingest(batch("2026-10-16T00:00:00Z" to -18.0, "2026-10-16T00:10:00Z" to -17.5))
        store(root).ingest(batch("2026-10-16T00:05:00Z" to 3.0, vehicle = "V-2", sensor = "S-9"))

        val latest = store(root).latest()
        assertThat(latest.map { Triple(it.vehicleId, it.sensorId, it.celsius) })
            .containsExactly(Triple("V-1", "S-1", -17.5), Triple("V-2", "S-9", 3.0))
        assertThat(latest[0].receivedAt).isEqualTo(now.get())
    }

    @Test
    fun `marks a sensor stale only after ten silent minutes`() {
        val store = store()
        store.ingest(batch("2026-10-16T00:59:00Z" to -18.0))
        val latest = store.latest().single()

        now.set(now.get().plus(Duration.ofMinutes(10)))
        assertThat(store.stale(latest)).isFalse()
        now.set(now.get().plusSeconds(1))
        assertThat(store.stale(latest)).isTrue()
    }

    @Test
    fun `reads a range across two days oldest first`() {
        val store = store()
        store.ingest(
            batch("2026-10-16T14:59:00Z" to -18.0, "2026-10-16T15:01:00Z" to -17.0, "2026-10-16T16:00:00Z" to 1.0),
        )

        val read = store.readings("V-1", Instant.parse("2026-10-16T14:30:00Z"), Instant.parse("2026-10-16T15:30:00Z"))
        assertThat(read.map { it.celsius }).containsExactly(-18.0, -17.0)
        assertThat(store.readings("V-9", Instant.parse("2026-10-16T14:30:00Z"), Instant.parse("2026-10-16T15:30:00Z")))
            .isEmpty()
    }

    @Test
    fun `checks the body as a whole and rejects it with a code`() {
        val ok = """[{"measuredAt":"2026-10-16T09:59:00+09:00","celsius":-18.4,"compartment":"frozen"}]"""
        val parsed = parseBatch(body(ok), now.get())
        assertThat(parsed.readings.single().compartment).isEqualTo("frozen")
        assertThat(parsed.readings.single().measuredAt).isEqualTo(Instant.parse("2026-10-16T00:59:00Z"))

        fun bad(measurements: String, extra: String = "") = codeOf { parseBatch(body(measurements, extra), now.get()) }
        fun one(field: String) = """[{"measuredAt":"2026-10-16T09:59:00+09:00","celsius":-1,$field}]"""
        fun celsius(value: String) = """[{"measuredAt":"2026-10-16T09:59:00+09:00","celsius":$value}]"""
        assertThat(bad(celsius("-60.1"))).isEqualTo("TEMPERATURE_OUT_OF_BOUNDS")
        assertThat(bad(celsius("60.1"))).isEqualTo("TEMPERATURE_OUT_OF_BOUNDS")
        assertThat(bad("""[{"measuredAt":"2026-10-16T10:06:00+09:00","celsius":1}]""")).isEqualTo("MEASURED_AT_FUTURE")
        assertThat(bad("""[{"measuredAt":"2026-10-09T09:59:00+09:00","celsius":1}]""")).isEqualTo("MEASURED_AT_TOO_OLD")
        assertThat(bad("""[{"measuredAt":"2026-10-16 09:59","celsius":1}]""")).isEqualTo("INVALID_TELEMETRY")
        assertThat(bad("""[{"measuredAt":"2026-10-16T09:59:00+09:00","celsius":"1"}]""")).isEqualTo("INVALID_TELEMETRY")
        assertThat(bad("[]")).isEqualTo("INVALID_TELEMETRY")
        assertThat(bad(celsius("1"), ""","extra":1""")).isEqualTo("INVALID_TELEMETRY")
        assertThat(bad(one(""""compartment":"warm""""))).isEqualTo("INVALID_TELEMETRY")
        assertThat(bad(one(""""unit":"C""""))).isEqualTo("INVALID_TELEMETRY")
        val many = (1..501).joinToString(",", "[", "]") { """{"measuredAt":"2026-10-16T09:00:00+09:00","celsius":1}""" }
        assertThat(bad(many)).isEqualTo("INVALID_TELEMETRY")
        val unsafe = json.readTree("""{"vehicleId":"../x","sensorId":"S","measurements":$ok}""") as ObjectNode
        assertThat(codeOf { parseBatch(unsafe, now.get()) }).isEqualTo("INVALID_TELEMETRY")
        val reserved = json.readTree("""{"vehicleId":"latest","sensorId":"S","measurements":$ok}""") as ObjectNode
        assertThat(codeOf { parseBatch(reserved, now.get()) }).isEqualTo("INVALID_TELEMETRY")
    }

    @Test
    fun `folds a minute into one row with mean min max and count`() {
        val readings = listOf(
            Reading("S-1", Instant.parse("2026-10-16T00:00:10Z"), -18.0, null),
            Reading("S-1", Instant.parse("2026-10-16T00:00:50Z"), -17.0, null),
            Reading("S-1", Instant.parse("2026-10-16T00:01:00Z"), -16.0, null),
            Reading("S-2", Instant.parse("2026-10-16T00:00:20Z"), 4.0, null),
        )
        val from = Instant.parse("2026-10-16T00:00:00Z")
        val view = historyView("V-1", readings, from, from.plusSeconds(300), true)

        val rows = view.path("measurements").toList()
        assertThat(rows.map { it.path("measuredAt").asString() }).containsExactly(
            "2026-10-16T09:00:00+09:00", "2026-10-16T09:01:00+09:00", "2026-10-16T09:00:00+09:00",
        )
        assertThat(rows[0].path("celsius").doubleValue()).isEqualTo(-17.5)
        assertThat(rows[0].path("min").doubleValue()).isEqualTo(-18.0)
        assertThat(rows[0].path("max").doubleValue()).isEqualTo(-17.0)
        assertThat(rows[0].path("count").asInt()).isEqualTo(2)
    }
}
