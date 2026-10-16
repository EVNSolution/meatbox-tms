package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.DRIVER_DIGEST
import com.evnsolution.meatbox.driver.DriverLocationPhotoTest
import com.evnsolution.meatbox.driver.RouteFixture
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import com.evnsolution.meatbox.resources.ResourceStore
import com.evnsolution.meatbox.resources.createV2Database
import com.evnsolution.meatbox.telemetry.Batch
import com.evnsolution.meatbox.telemetry.Reading
import com.evnsolution.meatbox.telemetry.TemperatureStore
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import java.util.zip.ZipFile

class ExportWriterTest {
    @TempDir lateinit var directory: Path

    private val readings = listOf("2026-10-13T00:59:30Z" to -18.4, "2026-10-13T01:00:30Z" to -18.1)

    /** A published date: a completed and a failed stop, a photo, a device, temperatures and a resource register. */
    private class World(val fixture: RouteFixture, val writer: ExportWriter, val database: Path, val photo: String)

    private fun world(): World {
        val f = routeFixture(directory)
        f.driver.register(DRIVER_DATE, "alice", DRIVER_DIGEST, "G1", "secret-device-token", "device-1")
        f.driver.activity.acceptEvent(DRIVER_DATE, event("e-depart", "departed", """{"stopOrder":["O4","O3","O1"]}"""))
        val photo = f.driver.activity.savePhoto(DRIVER_DATE, DriverLocationPhotoTest.JPEG).path("photoId").asString()
        val done = """{"stopId":"O4","orderIds":["O4"],"photoIds":["$photo"],"note":"문 앞"}"""
        f.driver.activity.acceptEvent(DRIVER_DATE, event("e-done", "stop_completed", done))
        val failed = """{"stopId":"O3","reasonCode":"ABSENT"}"""
        f.driver.activity.acceptEvent(DRIVER_DATE, event("e-fail", "stop_failed", failed))
        val telemetry = TemperatureStore(f.state.resolve("telemetry"), { Instant.parse("2026-10-13T02:00:00Z") })
        telemetry.ingest(Batch("G1", "S-1", readings.map { (at, c) -> Reading("S-1", Instant.parse(at), c, null) }))
        val database = directory.toRealPath().resolve("resources/registry.sqlite").also(::createV2Database)
        val sources = ExportSources(f.state, database, f.dispatch::sourceDay) { f.dispatch.snapshot(it) }
        val writer = ExportWriter(sources, "test", "abc123") { Instant.parse("2026-10-13T03:00:00Z") }
        return World(f, writer, database, photo)
    }

    private fun export(writer: ExportWriter, request: ExportRequest = ExportRequest.of(null, null, null)): Archive {
        val target = directory.resolve("out-${System.nanoTime()}.zip")
        val manifest = writer.write(request, target)
        return Archive(target, manifest)
    }

    private class Archive(val path: Path, val manifest: ObjectNode) {
        fun names(): Set<String> = ZipFile(path.toFile()).use { zip -> zip.entries().toList().map { it.name }.toSet() }

        fun bytes(name: String): ByteArray = ZipFile(path.toFile()).use { zip ->
            zip.getInputStream(zip.getEntry(name)).readAllBytes()
        }

        fun json(name: String): JsonNode = driverJson.readTree(bytes(name))
    }

    @Test
    fun `every file matches its manifest hash and the manifest names exactly the files that it lists`() {
        val archive = export(world().writer)

        val listed = archive.manifest.path("files").toList()
        assertThat(archive.names()).isEqualTo(listed.map { it.path("path").asString() }.toSet() + "manifest.json")
        listed.forEach { file ->
            val bytes = archive.bytes(file.path("path").asString())
            val path = file.path("path").asString()
            assertThat(sha256(bytes)).describedAs(path).isEqualTo(file.path("sha256").asString())
            assertThat(bytes.size.toLong()).isEqualTo(file.path("size").asLong())
        }
        assertThat(archive.json("manifest.json").toString()).isEqualTo(archive.manifest.toString())
        assertThat(archive.manifest.path("schemaVersion").asInt()).isEqualTo(1)
        assertThat(archive.manifest.path("serverVersion").asString()).isEqualTo("test")
        assertThat(archive.manifest.path("exportedAt").asString()).isEqualTo("2026-10-13T12:00:00+09:00")
        assertThat(listed.none { it.has("changedDuringExport") }).isTrue()
        assertThat(archive.manifest.path("warnings").size()).isZero()
    }

    @Test
    fun `the dispatch checkpoint restores the same snapshot in a new state directory`() {
        val w = world()
        val before = w.fixture.dispatch.snapshot(DRIVER_DATE)
        val archive = export(w.writer)
        assertThat(archive.names())
            .contains("dispatch/$DRIVER_DATE.json", "dispatch/$DRIVER_DATE.summary.json", "source/$DRIVER_DATE.json")

        val restoredState = Files.createDirectories(directory.toRealPath().resolve("restored/state"))
        Files.write(restoredState.resolve("$DRIVER_DATE.json"), archive.bytes("dispatch/$DRIVER_DATE.json"))
        val restoredData = Files.createDirectories(directory.toRealPath().resolve("restored/data/days"))
        Files.writeString(
            restoredData.parent.resolve("manifest.json"),
            """{"schemaVersion":1,"defaultDate":"$DRIVER_DATE","dates":[{"date":"$DRIVER_DATE"}],""" +
                """"source":{"csvSha256":"fixture"}}""",
        )
        Files.write(restoredData.resolve("$DRIVER_DATE.json"), archive.bytes("source/$DRIVER_DATE.json"))
        val reader = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), restoredData.parent))
        val clock = { Instant.parse("${DRIVER_DATE}T01:00:00Z").toEpochMilli() }
        val restored = DispatchStore(reader, restoredState, clock)

        assertThat(restored.snapshot(DRIVER_DATE).put("boot", before.path("boot").asString())).isEqualTo(before)
    }

    @Test
    fun `the summary lists each vehicle's route with status, time, reason and photos`() {
        val summary = export(world().writer).json("dispatch/$DRIVER_DATE.summary.json")

        val stops = summary.path("vehicles").first { it.path("vehicleId").asString() == "G1" }.path("stops").toList()
        val byOrder = stops.associateBy { it.path("orderId").asString() }
        assertThat(byOrder.getValue("O4").path("status").asString()).isEqualTo("done")
        assertThat(byOrder.getValue("O4").path("sequence").asInt()).isEqualTo(1)
        assertThat(byOrder.getValue("O4").path("completedAt").asString()).isNotBlank()
        assertThat(byOrder.getValue("O4").path("closedBy").path("photoIds").size()).isEqualTo(1)
        assertThat(byOrder.getValue("O3").path("status").asString()).isEqualTo("skipped")
        assertThat(byOrder.getValue("O3").path("closedBy").path("reasonCode").asString()).isEqualTo("ABSENT")
        assertThat(byOrder.getValue("O1").path("eta").asString()).isNotBlank()
        val g1 = summary.path("vehicles").first { it.path("vehicleId").asString() == "G1" }
        assertThat(g1.path("etaComputedAt").asString()).isNotBlank()
    }

    @Test
    fun `the photo index matches the stop events and the photo bytes are the stored ones`() {
        val w = world()
        val archive = export(w.writer)

        val index = archive.json("photos/index.json").path("photos").toList()
        val events = archive.json("driver/$DRIVER_DATE.json").path("events").toList()
            .filter { it.path("type").asString() == "stop_completed" }
        val eventPhotos = events.flatMap { e -> e.path("photoIds").toList().map { it.asString() } }
        val ids = index.map { it.path("photoId").asString() }
        assertThat(ids).containsExactlyElementsOf(eventPhotos).containsExactly(w.photo)
        assertThat(index.single().path("stopId").asString()).isEqualTo("O4")
        assertThat(index.single().path("orderIds").toList().map { it.asString() }).containsExactly("O4")
        assertThat(archive.bytes(index.single().path("file").asString())).isEqualTo(DriverLocationPhotoTest.JPEG)
        assertThat(archive.manifest.path("counts").path("photos").asInt()).isEqualTo(1)
    }

    @Test
    fun `telemetry lines and counts equal what was stored, and the driver file holds no token`() {
        val archive = export(world().writer)

        val lines = String(archive.bytes("telemetry/G1/$DRIVER_DATE.jsonl")).lines().filter(String::isNotBlank)
        assertThat(lines).hasSize(readings.size)
        assertThat(archive.manifest.path("counts").path("telemetryReadings").asInt()).isEqualTo(readings.size)
        val driver = String(archive.bytes("driver/$DRIVER_DATE.json"))
        assertThat(driver).doesNotContain("secret-device-token", "sessionDigest", "alice", "device-1", DRIVER_DIGEST)
        val device = archive.json("driver/$DRIVER_DATE.json").path("devices").single()
        assertThat(device.path("vehicleId").asString()).isEqualTo("G1")
        assertThat(device.path("platform").asString()).isEqualTo("android")
        assertThat(archive.manifest.path("counts").path("driverDates").asInt()).isEqualTo(1)
        assertThat(archive.names().none { it.contains("auth") || it.contains("session") }).isTrue()
    }

    @Test
    fun `the resource register round trips through the exported JSON`() {
        val w = world()
        val archive = export(w.writer)

        val snapshot = ResourceStore(w.database).snapshot()
        val vehicles = archive.json("resources/vehicles.json").path("vehicles").toList()
        val active = vehicles.filter { it.path("active").asBoolean() }
        val rows = active.map {
            Triple(it.path("id").asString(), it.path("plate").asString(), it.path("regionCode").asString())
        }
        assertThat(rows)
            .containsExactlyInAnyOrderElementsOf(snapshot.vehicles.map { Triple(it.id, it.plate, it.regionCode) })
        assertThat(vehicles.map { it.path("id").asString() }).contains("G3")
        assertThat(archive.json("resources/region-codes.json").path("regionCodes").toList().map { it.asString() })
            .containsExactlyElementsOf(snapshot.regionCodes.map { it.code })
        assertThat(archive.json("resources/vehicles.json").path("revision").asLong()).isEqualTo(snapshot.revision)
        assertThat(archive.manifest.path("counts").path("vehicles").asInt()).isEqualTo(3)
        assertThat(archive.manifest.path("counts").path("regionCodes").asInt()).isEqualTo(3)
    }

    @Test
    fun `a range with nothing in it gives an archive with only the manifest and zero counts`() {
        val groups = listOf("orders", "dispatch", "driver", "photos", "telemetry")
        val archive = export(world().writer, ExportRequest.of("2030-01-01", "2030-12-31", groups))

        assertThat(archive.names()).containsExactly("manifest.json")
        assertThat(archive.manifest.path("counts").properties().map { it.value.asInt() }).allMatch { it == 0 }
        assertThat(archive.manifest.path("files").size()).isZero()
        assertThat(archive.manifest.path("range").path("from").asString()).isEqualTo("2030-01-01")
    }

    @Test
    fun `include leaves groups out`() {
        val archive = export(world().writer, ExportRequest.of(DRIVER_DATE, DRIVER_DATE, listOf("telemetry")))

        assertThat(archive.names()).containsExactlyInAnyOrder("manifest.json", "telemetry/G1/$DRIVER_DATE.jsonl")
    }

    @Test
    fun `a line that is still being written is left out and the file is marked changed`() {
        val w = world()
        val file = w.fixture.state.resolve("telemetry/G1/$DRIVER_DATE.jsonl")
        Files.write(file, "{\"t\":\"half".toByteArray(), java.nio.file.StandardOpenOption.APPEND)

        val archive = export(w.writer, ExportRequest.of(null, null, listOf("telemetry")))

        val entry = archive.manifest.path("files").first { it.path("path").asString().endsWith(".jsonl") }
        assertThat(entry.path("changedDuringExport").asBoolean()).isTrue()
        assertThat(archive.bytes("telemetry/G1/$DRIVER_DATE.jsonl").last()).isEqualTo('\n'.code.toByte())
        assertThat(archive.manifest.path("counts").path("telemetryReadings").asInt()).isEqualTo(readings.size)
    }

    @Test
    fun `an invalid request is refused`() {
        for (bad in listOf(
            { ExportRequest.of("2026-02-30", null, null) },
            { ExportRequest.of("2026-10-14", "2026-10-13", null) },
            { ExportRequest.of(null, null, listOf("auth")) },
            { ExportRequest.of(null, null, emptyList()) },
        )) {
            org.assertj.core.api.Assertions.assertThatThrownBy { bad() }
                .isInstanceOfSatisfying(com.evnsolution.meatbox.dispatch.DispatchException::class.java) {
                    assertThat(it.status).isEqualTo(400)
                    assertThat(it.code).isEqualTo("INVALID_EXPORT")
                }
        }
    }

    private fun event(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
        "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode
}

internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
