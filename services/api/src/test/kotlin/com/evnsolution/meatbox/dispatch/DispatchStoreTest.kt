package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.legacy.LegacySettings
import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.legacy.DispatchDataReader
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.http.HttpStatus
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

class DispatchStoreTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `rejects invalid source dates before creating a plan or checkpoint`() {
        val store = fixture()

        for (day in invalidDays()) {
            writeDay(day)
            assertInvalidSource { store.snapshot(DATE) }
            assertInvalidSource { store.command(DATE, calculate(store)) }
            assertNoCheckpoint()
        }
    }

    @Test
    fun `rejects changed source dates with a warm plan cache and preserves the saved checkpoint`() {
        val store = fixture()
        store.command(DATE, calculate(store))
        val checkpoint = Files.readAllBytes(directory.resolve("state/$DATE.json"))
        val original = store.snapshot(DATE)

        for (day in invalidDays()) {
            writeDay(day)
            assertInvalidSource { store.snapshot(DATE) }
            assertInvalidSource { store.command(DATE, calculate(store, original.path("revision").asLong())) }
            assertThat(Files.readAllBytes(directory.resolve("state/$DATE.json"))).isEqualTo(checkpoint)
        }

        writeDay(validDay())
        assertThat(store.snapshot(DATE)).isEqualTo(original)
        val restored = DispatchStore(reader(), directory.resolve("state"), ::now)
        val restoredState = restored.snapshot(DATE).apply { put("boot", store.boot) }
        assertThat(restoredState).isEqualTo(original)
    }

    @Test
    fun `does not let a warm cache create a checkpoint after an invalid source replacement`() {
        val store = fixture()
        store.snapshot(DATE)
        writeDay(invalidDays().first())

        assertInvalidSource { store.command(DATE, calculate(store)) }
        assertNoCheckpoint()
    }

    @Test
    fun `answers a resent request id with the first result and applies it once`() {
        val store = fixture()
        val first = store.command(DATE, calculate(store).put("requestId", "req-1"))
        val resent = store.command(DATE, calculate(store).put("requestId", "req-1"))

        assertSameJson(resent, first)
        assertThat(store.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
        assertThat(first.path("state").path("revision").asLong()).isEqualTo(1)
        assertSameJson(store.result(DATE, "req-1"), first)
    }

    @Test
    fun `rejects a reused request id with a different body and leaves the state alone`() {
        val store = fixture()
        store.command(DATE, calculate(store).put("requestId", "req-1"))
        val other = calculate(store, 1).put("requestId", "req-1").apply {
            set("vehicleIds", dispatchMapper.createArrayNode())
        }

        assertCode(HttpStatus.CONFLICT, "REQUEST_ID_MISMATCH") { store.command(DATE, other) }
        assertThat(store.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
    }

    @Test
    fun `ignores key order and the request id itself when comparing bodies`() {
        val store = fixture()
        val first = store.command(DATE, calculate(store).put("requestId", "req-1"))
        val reordered = dispatchMapper.createObjectNode().apply {
            set("vehicleIds", dispatchMapper.createArrayNode().add("G1"))
            put("requestId", "req-1")
            put("expectedRevision", 0)
            put("expectedBoot", store.boot)
            put("type", "calculate_dispatch")
        }

        assertSameJson(store.command(DATE, reordered), first)
    }

    @Test
    fun `answers a resent request id after a restart even though the boot changed`() {
        val store = fixture()
        val first = store.command(DATE, calculate(store).put("requestId", "req-1"))
        val restarted = DispatchStore(reader(), directory.resolve("state"), ::now)

        assertThat(restarted.boot).isNotEqualTo(store.boot)
        assertSameJson(restarted.command(DATE, calculate(store).put("requestId", "req-1")), first)
        assertSameJson(restarted.result(DATE, "req-1"), first)
        assertThat(restarted.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
        assertCode(HttpStatus.NOT_FOUND, "REQUEST_NOT_FOUND") { restarted.result(DATE, "req-2") }
    }

    @Test
    fun `keeps neither result nor state when the checkpoint write fails`() {
        val store = fixture()
        store.command(DATE, calculate(store))
        val target = directory.resolve("state/$DATE.json")
        val saved = Files.readAllBytes(target)
        Files.delete(target)
        Files.createDirectory(target)

        assertCode(HttpStatus.INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED") {
            store.command(DATE, calculate(store, 1).put("requestId", "req-2"))
        }
        assertThat(store.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
        assertCode(HttpStatus.NOT_FOUND, "REQUEST_NOT_FOUND") { store.result(DATE, "req-2") }
        Files.delete(target)
        Files.write(target, saved)
        assertThat(String(Files.readAllBytes(target))).doesNotContain("req-2")
    }

    @Test
    fun `drops the oldest results past the count limit and past 24 hours`() {
        val store = fixture()
        repeat(501) { store.command(DATE, calculate(store, it.toLong()).put("requestId", "req-$it")) }

        assertCode(HttpStatus.NOT_FOUND, "REQUEST_NOT_FOUND") { store.result(DATE, "req-0") }
        assertThat(store.result(DATE, "req-1").path("state").path("revision").asLong()).isEqualTo(2)
        assertThat(store.result(DATE, "req-500").path("state").path("revision").asLong()).isEqualTo(501)
        val restarted = DispatchStore(reader(), directory.resolve("state"), ::now)
        assertSameJson(restarted.result(DATE, "req-500"), store.result(DATE, "req-500"))

        clockMillis += 24 * 60 * 60 * 1000L
        assertCode(HttpStatus.NOT_FOUND, "REQUEST_NOT_FOUND") { store.result(DATE, "req-500") }
    }

    @Test
    fun `restores an existing checkpoint that has no stored results`() {
        val store = fixture()
        store.command(DATE, calculate(store))
        assertThat(String(Files.readAllBytes(directory.resolve("state/$DATE.json")))).doesNotContain("commandResults")

        val restarted = DispatchStore(reader(), directory.resolve("state"), ::now)
        assertThat(restarted.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
        assertCode(HttpStatus.NOT_FOUND, "REQUEST_NOT_FOUND") { restarted.result(DATE, "req-1") }
    }

    @Test
    fun `rejects a malformed request id`() {
        val store = fixture()
        for (bad in listOf("", "a".repeat(65), "has space", "x;y")) {
            assertCode(HttpStatus.BAD_REQUEST, "INVALID_COMMAND") {
                store.command(DATE, calculate(store).put("requestId", bad))
            }
        }
        assertCode(HttpStatus.BAD_REQUEST, "INVALID_COMMAND") {
            store.command(DATE, calculate(store).apply { put("requestId", 7) })
        }
        assertNoCheckpoint()
    }

    // Clients see bytes, so compare the serialized form.
    private fun assertSameJson(actual: ObjectNode, expected: ObjectNode) {
        assertThat(dispatchMapper.writeValueAsString(actual)).isEqualTo(dispatchMapper.writeValueAsString(expected))
    }

    private fun assertCode(status: HttpStatus, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status.value())
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun fixture(): DispatchStore {
        // macOS temporary paths can contain the /var symlink; use the actual safe directory.
        directory = directory.toRealPath()
        Files.createDirectories(directory.resolve("data/days"))
        Files.createDirectory(directory.resolve("state"))
        Files.writeString(
            directory.resolve("data/manifest.json"),
            """{"schemaVersion":1,"defaultDate":"$DATE","dates":[{"date":"$DATE"}],"source":{"csvSha256":"fixture"}}""",
        )
        writeDay(validDay())
        return DispatchStore(reader(), directory.resolve("state"), ::now)
    }

    private fun reader() = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), directory.resolve("data")))

    private fun calculate(store: DispatchStore, revision: Long = 0) = dispatchMapper.createObjectNode().apply {
        put("type", "calculate_dispatch")
        put("expectedBoot", store.boot)
        put("expectedRevision", revision)
        set("vehicleIds", dispatchMapper.createArrayNode().add("G1"))
    }

    private fun invalidDays() = listOf(
        validDay().replace(DATE, "2026-10-06"),
        validDay().replace("\"date\":\"$DATE\",", ""),
    )

    private fun validDay() = """
        {"schemaVersion":1,"date":"$DATE","summary":{"orders":1,"boxes":1},
         "groups":[{"id":"G1","label":"합성 기사","regionNames":["합성 권역"]}],
         "orders":[{"id":"O1","groupId":"G1","name":"합성 배송지","address":"합성 주소",
                    "boxes":1,"sourceRows":1,"sequence":1,"coordinates":[127.0,37.5],"zoneIds":["Z1"]}]}
    """.trimIndent()

    private fun writeDay(day: String) {
        Files.writeString(directory.resolve("data/days/$DATE.json"), day)
    }

    private fun assertInvalidSource(block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchDataException::class.java) {
            assertThat(it.status).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR)
            assertThat(it.code).isEqualTo("DISPATCH_DATA_INVALID")
        }
    }

    private fun assertNoCheckpoint() {
        Files.list(directory.resolve("state")).use { assertThat(it.count()).isZero() }
    }

    private var clockMillis = Instant.parse("2026-10-05T01:00:00Z").toEpochMilli()

    private fun now() = clockMillis

    companion object {
        private const val DATE = "2026-10-05"
    }
}
