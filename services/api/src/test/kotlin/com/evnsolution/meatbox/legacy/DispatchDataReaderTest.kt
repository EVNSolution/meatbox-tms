package com.evnsolution.meatbox.legacy

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPOutputStream

class DispatchDataReaderTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `preserves raw manifest day and region bytes including unknown metadata`() {
        val fixture = fixture()
        val reader = reader()

        assertThat(reader.manifest(null).bytes).isEqualTo(fixture.manifest)
        assertThat(reader.day(DATE, null).bytes).isEqualTo(fixture.day)
        assertThat(reader.regions(null).bytes).isEqualTo(fixture.regions)
    }

    @Test
    fun `selects a safe gzip sibling and gives each representation its own etag`() {
        val fixture = fixture()
        val gzip = gzip(fixture.day)
        Files.write(directory.resolve("days/$DATE.json.gz"), gzip)
        val reader = reader()

        val plain = reader.day(DATE, null)
        val compressed = reader.day(DATE, "br, gzip")

        assertThat(plain.bytes).isEqualTo(fixture.day)
        assertThat(plain.contentEncoding).isNull()
        assertThat(plain.varyAcceptEncoding).isTrue()
        assertThat(compressed.bytes).isEqualTo(gzip)
        assertThat(compressed.contentEncoding).isEqualTo("gzip")
        assertThat(compressed.etag).isNotEqualTo(plain.etag)

        val explicitlyRejected = reader.day(DATE, "gzip;q=0.000, *;q=1")
        assertThat(explicitlyRejected.bytes).isEqualTo(fixture.day)
        assertThat(explicitlyRejected.contentEncoding).isNull()
    }

    @Test
    fun `does not serve an orphan gzip representation without its source file`() {
        val fixture = fixture()
        Files.write(directory.resolve("days/$DATE.json.gz"), gzip(fixture.day))
        Files.delete(directory.resolve("days/$DATE.json"))

        assertError("DISPATCH_DATA_NOT_FOUND") { reader().day(DATE, "gzip") }
    }

    @Test
    fun `rejects wrong or missing raw day dates even with a valid gzip sibling`() {
        val fixture = fixture()
        Files.write(directory.resolve("days/$DATE.json.gz"), gzip(fixture.day))
        val reader = reader()

        for (day in listOf("{\"date\":\"2026-10-06\"}", "{\"orders\":[]}")) {
            Files.writeString(directory.resolve("days/$DATE.json"), day)
            for (encoding in listOf(null, "gzip")) {
                assertError("DISPATCH_DATA_INVALID") { reader.day(DATE, encoding) }
            }
        }
    }

    @Test
    fun `rejects wrong or missing dates in the selected gzip representation`() {
        val fixture = fixture()
        val reader = reader()

        for (day in listOf("{\"date\":\"2026-10-06\"}", "{\"orders\":[]}")) {
            Files.write(directory.resolve("days/$DATE.json.gz"), gzip(day.toByteArray()))
            assertThat(reader.day(DATE, null).bytes).isEqualTo(fixture.day)
            assertError("DISPATCH_DATA_INVALID") { reader.day(DATE, "gzip") }
        }
    }

    @Test
    fun `bounds gzip expansion at the existing dispatch day size limit`() {
        val fixture = fixture()
        val reader = reader()
        val limit = 16 * 1024 * 1024
        val atLimit = fixture.day.copyOf(limit).apply { fill(' '.code.toByte(), fixture.day.size) }
        val compressed = gzip(atLimit)
        Files.write(directory.resolve("days/$DATE.json.gz"), compressed)
        assertThat(reader.day(DATE, "gzip").bytes).isEqualTo(compressed)

        val excessive = atLimit.copyOf(limit + 1).apply { this[limit] = ' '.code.toByte() }
        Files.write(directory.resolve("days/$DATE.json.gz"), gzip(excessive))
        assertError("DISPATCH_DATA_INVALID") { reader.day(DATE, "gzip") }
        assertThat(reader.day(DATE, null).bytes).isEqualTo(fixture.day)
    }

    @Test
    fun `bounds raw day bytes before parsing even with a valid gzip sibling`() {
        val fixture = fixture()
        val reader = reader()
        val limit = 16 * 1024 * 1024
        val atLimit = fixture.day.copyOf(limit).apply { fill(' '.code.toByte(), fixture.day.size) }
        Files.write(directory.resolve("days/$DATE.json"), atLimit)
        Files.write(directory.resolve("days/$DATE.json.gz"), gzip(fixture.day))
        assertThat(reader.day(DATE, null).bytes).isEqualTo(atLimit)

        val excessive = atLimit.copyOf(limit + 1).apply { this[limit] = ' '.code.toByte() }
        Files.write(directory.resolve("days/$DATE.json"), excessive)
        for (encoding in listOf(null, "gzip")) {
            assertError("DISPATCH_DATA_INVALID") { reader.day(DATE, encoding) }
        }
    }

    @Test
    fun `maps manifest and target failures to the legacy error stages`() {
        var reader = reader()
        assertError("DISPATCH_DATA_UNAVAILABLE") { reader.manifest(null) }

        Files.writeString(directory.resolve("manifest.json"), "{broken")
        assertError("DISPATCH_DATA_INVALID") { reader.manifest(null) }

        fixture()
        reader = reader()
        assertError("DISPATCH_DATA_NOT_FOUND") { reader.day("2026-02-30", null) }
        assertError("DISPATCH_DATA_NOT_FOUND") { reader.day("2026-10-06", null) }
        Files.delete(directory.resolve("regions.geojson"))
        assertError("DISPATCH_DATA_NOT_FOUND") { reader.regions(null) }
    }

    @Test
    fun `rejects symlinked source files without exposing their contents`() {
        fixture()
        val outside = Files.createTempFile("meatbox-dispatch-outside-", ".json")
        Files.writeString(outside, "{\"secret\":true}")
        Files.delete(directory.resolve("regions.geojson"))
        Files.createSymbolicLink(directory.resolve("regions.geojson"), outside)

        assertError("DISPATCH_DATA_INVALID") { reader().regions(null) }

        Files.deleteIfExists(outside)
    }

    @Test
    fun `rejects duplicate dates and a default date outside the allowlist`() {
        Files.writeString(
            directory.resolve("manifest.json"),
            """{"schemaVersion":1,"defaultDate":"$DATE","dates":[{"date":"2026-10-04"},{"date":"2026-10-04"}]}""",
        )
        assertError("DISPATCH_DATA_INVALID") { reader().manifest(null) }
    }

    private fun fixture(): Fixture {
        Files.createDirectories(directory.resolve("days"))
        val manifest = """
            { "schemaVersion": 1, "defaultDate": "$DATE", "vendorMetadata": {"keep": true},
              "dates": [{"date":"$DATE","weekday":"월요일","other":"kept"}] }
        """.trimIndent().toByteArray()
        val day = "{\"date\":\"$DATE\",\"vendorMetadata\":{\"keep\":true},\"orders\":[{\"id\":\"A\"}]}\n".toByteArray()
        val regions = "{\"type\":\"FeatureCollection\",\"features\":[]}\n".toByteArray()
        Files.write(directory.resolve("manifest.json"), manifest)
        Files.write(directory.resolve("days/$DATE.json"), day)
        Files.write(directory.resolve("regions.geojson"), regions)
        return Fixture(manifest, day, regions)
    }

    private fun reader() = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), directory))

    private fun gzip(value: ByteArray): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        GZIPOutputStream(output).use { it.write(value) }
        return output.toByteArray()
    }

    private fun assertError(code: String, block: () -> Unit) {
        assertThatThrownBy(block)
            .isInstanceOfSatisfying(DispatchDataException::class.java) { error ->
                assertThat(error.code).isEqualTo(code)
            }
    }

    private data class Fixture(val manifest: ByteArray, val day: ByteArray, val regions: ByteArray)

    companion object {
        private const val DATE = "2026-10-05"
    }
}
