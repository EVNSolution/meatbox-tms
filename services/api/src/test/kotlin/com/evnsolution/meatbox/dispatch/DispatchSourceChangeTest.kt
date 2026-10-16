package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** What the operator meets when the prepared source of a date changes under its saved plan. */
class DispatchSourceChangeTest {
    @TempDir lateinit var directory: Path

    private val seen = mutableListOf<Pair<String, SourceConflict>>()
    private var now = Instant.parse("2026-10-05T01:00:00Z").toEpochMilli()

    private fun write(path: String, text: String) = Files.writeString(directory.resolve(path), text)

    private fun manifest(hash: String) = write(
        "data/manifest.json",
        """{"schemaVersion":1,"defaultDate":"$DATE","dates":[{"date":"$DATE"},{"date":"$OTHER"}],
           "source":{"csvSha256":"$hash"}}""",
    )

    private fun day(date: String, address: String = "합성 주소", group: String = "G1") = write(
        "data/days/$date.json",
        """{"schemaVersion":1,"date":"$date","summary":{"orders":1,"boxes":1},
           "groups":[{"id":"$group","label":"합성 기사","regionNames":["합성 권역"]}],
           "orders":[{"id":"O1","groupId":"$group","name":"합성 배송지","address":"$address",
                      "boxes":1,"sourceRows":1,"sequence":1,"coordinates":[127.0,37.5],"zoneIds":["Z1"]}]}""",
    )

    private fun open(): DispatchStore {
        directory = directory.toRealPath()
        Files.createDirectories(directory.resolve("data/days"))
        Files.createDirectories(directory.resolve("state"))
        manifest("hash-1")
        day(DATE); day(OTHER)
        return store()
    }

    private fun store() = DispatchStore(
        DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), directory.resolve("data"))),
        directory.resolve("state"), { now },
    ).also { store -> store.onSourceConflict = { date, conflict -> seen += date to conflict } }

    private fun calculate(store: DispatchStore, date: String) = store.command(
        date,
        dispatchMapper.createObjectNode().apply {
            put("type", "calculate_dispatch"); put("expectedBoot", store.boot); put("expectedRevision", 0)
            set("vehicleIds", dispatchMapper.createArrayNode().add("G1"))
        },
    )

    private fun checkpointFile(date: String = DATE) = directory.resolve("state/$date.json")

    private fun checkpoint(date: String = DATE) =
        dispatchMapper.readTree(Files.readAllBytes(checkpointFile(date))) as ObjectNode

    private fun assertFails(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun assertChanged(store: DispatchStore, date: String = DATE, reason: String) {
        assertFails(409, "SOURCE_CHANGED") { store.snapshot(date) }
        val command = dispatchMapper.createObjectNode().put("expectedBoot", store.boot)
        assertFails(409, "SOURCE_CHANGED") { store.command(date, command) }
        val shown = store.stateOrConflict(date)
        assertThat(shown.path("sourceConflict").path("reason").asString()).isEqualTo(reason)
        assertThat(shown.path("dispatch").isNull).isTrue()
    }

    @Test
    fun `a re-prepared bundle closes every date with a saved plan, warm or cold, and keeps the checkpoint`() {
        val warm = open()
        calculate(warm, DATE); calculate(warm, OTHER)
        val saved = Files.readAllBytes(checkpointFile())
        manifest("hash-2")
        for (store in listOf(warm, store())) {
            assertChanged(store, DATE, "source"); assertChanged(store, OTHER, "source")
            val conflict = store.stateOrConflict(DATE).path("sourceConflict")
            assertThat(conflict.path("expectedSourceId").asString()).isEqualTo("hash-1")
            assertThat(conflict.path("actualSourceId").asString()).isEqualTo("hash-2")
            assertThat(conflict.path("checkpointPhase").asString()).isEqualTo("draft")
            assertThat(conflict.path("detectedAt").asString()).isEqualTo("2026-10-05T01:00:00Z")
        }
        assertThat(Files.readAllBytes(checkpointFile())).isEqualTo(saved)
    }

    @Test
    fun `a conflict is reported once per change and keeps its first detection time`() {
        val store = open()
        calculate(store, DATE)
        manifest("hash-2")
        repeat(3) { runCatching { store.snapshot(DATE) } }
        now += 60_000
        assertThat(store.stateOrConflict(DATE).path("sourceConflict").path("detectedAt").asString())
            .isEqualTo("2026-10-05T01:00:00Z")
        assertThat(seen.map { it.first }).containsExactly(DATE)
    }

    @Test
    fun `a date without a saved plan simply follows the new bundle`() {
        val store = open()
        calculate(store, DATE)
        manifest("hash-2")
        assertThat(store.snapshot(OTHER).toString()).contains("합성 주소")
    }

    @Test
    fun `changed day content under the same bundle hash is a conflict that undoing the change clears`() {
        val warm = open()
        calculate(warm, DATE)
        day(DATE, address = "바뀐 주소")
        assertChanged(warm, reason = "content")
        assertChanged(store(), reason = "content")
        day(DATE)
        assertThat(warm.snapshot(DATE).toString()).contains("합성 주소")
    }

    @Test
    fun `a legacy checkpoint from the same source is bound to its content in place`() {
        calculate(open(), DATE)
        write("state/$DATE.json", checkpoint().apply { remove("contentHash") }.toString())
        val loaded = store()
        assertThat(loaded.snapshot(DATE).path("revision").asLong()).isEqualTo(1)
        assertThat(checkpoint().path("contentHash").asString()).hasSize(64)
        day(DATE, address = "바뀐 주소")
        assertChanged(loaded, reason = "content")
    }

    @Test
    fun `a legacy checkpoint from another source is a conflict`() {
        calculate(open(), DATE)
        write("state/$DATE.json", checkpoint().apply { remove("contentHash") }.toString())
        manifest("hash-2")
        assertChanged(store(), reason = "source")
    }

    @Test
    fun `keep-checkpoint binds a draft to the new source and keeps its revision`() {
        val store = open()
        calculate(store, DATE)
        manifest("hash-2")
        day(DATE, address = "바뀐 주소")
        val reply = store.resolveSourceConflict(DATE, "keep-checkpoint", "ops")
        assertThat(reply.path("previousPhase").asString()).isEqualTo("draft")
        assertThat(checkpoint().path("sourceId").asString()).isEqualTo("hash-2")
        val resolved = store.snapshot(DATE)
        assertThat(resolved.path("revision").asLong()).isEqualTo(1)
        assertThat(resolved.toString()).contains("바뀐 주소")
        assertThat(store().snapshot(DATE).path("revision").asLong()).isEqualTo(1)
    }

    @Test
    fun `keep-checkpoint refuses a plan that vehicles can run and a plan the new source cannot hold`() {
        val store = open()
        calculate(store, DATE); calculate(store, OTHER)
        manifest("hash-2")
        write("state/$DATE.json", checkpoint().put("phase", "published").toString())
        val saved = Files.readAllBytes(checkpointFile())
        assertFails(409, "SOURCE_CHANGE_UNSAFE") { store.resolveSourceConflict(DATE, "keep-checkpoint", "ops") }
        day(OTHER, group = "G2")
        assertFails(409, "SOURCE_CHANGE_INCOMPATIBLE") { store.resolveSourceConflict(OTHER, "keep-checkpoint", "ops") }
        assertThat(Files.readAllBytes(checkpointFile())).isEqualTo(saved)
        assertChanged(store, DATE, "source")
    }

    @Test
    fun `discard-checkpoint moves the plan aside and returns the date to unplanned`() {
        val store = open()
        calculate(store, DATE)
        val saved = Files.readAllBytes(checkpointFile())
        manifest("hash-2")
        val reply = store.resolveSourceConflict(DATE, "discard-checkpoint", "ops")
        val backup = directory.resolve("state/${reply.path("backup").asString()}")
        assertThat(backup.fileName.toString()).startsWith("$DATE.json.discarded-")
        assertThat(Files.readAllBytes(backup)).isEqualTo(saved)
        assertThat(Files.exists(checkpointFile())).isFalse()
        assertThat(store.snapshot(DATE).path("revision").asLong()).isZero()
    }

    @Test
    fun `resolving without a conflict or with an unknown action changes nothing`() {
        val store = open()
        calculate(store, DATE)
        val saved = Files.readAllBytes(checkpointFile())
        assertFails(409, "NO_SOURCE_CONFLICT") { store.resolveSourceConflict(DATE, "keep-checkpoint", "ops") }
        assertFails(409, "NO_SOURCE_CONFLICT") { store.resolveSourceConflict(OTHER, "discard-checkpoint", "ops") }
        manifest("hash-2")
        assertFails(400, "INVALID_ACTION") { store.resolveSourceConflict(DATE, "delete", "ops") }
        assertThat(Files.readAllBytes(checkpointFile())).isEqualTo(saved)
    }

    companion object {
        private const val DATE = "2026-10-05"
        private const val OTHER = "2026-10-06"
    }
}
