package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.compat.CompatSettings
import com.evnsolution.meatbox.compat.DispatchDataException
import com.evnsolution.meatbox.compat.DispatchDataReader
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.http.HttpStatus
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

    private fun reader() = DispatchDataReader(CompatSettings(URI("http://127.0.0.1:1"), directory.resolve("data")))

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

    private fun now() = Instant.parse("2026-10-05T01:00:00Z").toEpochMilli()

    companion object {
        private const val DATE = "2026-10-05"
    }
}
