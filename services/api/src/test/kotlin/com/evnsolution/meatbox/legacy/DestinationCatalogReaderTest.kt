package com.evnsolution.meatbox.legacy

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream

class DestinationCatalogReaderTest {
    @TempDir
    lateinit var directory: Path

    private val mapper = JsonMapper.builder().build()

    @BeforeEach
    fun writeFixture() {
        Files.writeString(directory.resolve("manifest.json"), MANIFEST)
        Files.writeString(directory.resolve("destinations.json"), CATALOG)
    }

    @Test
    fun `matches the Node cumulative snapshot and does not expose source fields`() {
        val body = json(reader().destinations(query(), null).bytes)

        assertThat(body).isEqualTo(mapper.readTree(EXPECTED_DEFAULT))
        assertThat(body.toString()).doesNotContain("buyer", "must-not-leak", "manifestSignature", "csvSha256")
    }

    @Test
    fun `keeps summary independent of search and clamps paging`() {
        val first = json(
            reader().destinations(
                query(date = "2025-09-17", q = "상점", page = "1", pageSize = "1"),
                null,
            ).bytes,
        )
        val second = json(
            reader().destinations(
                query(date = "2025-09-17", q = "상점", page = "2", pageSize = "1"),
                null,
            ).bytes,
        )
        val clamped = json(
            reader().destinations(
                query(date = "2025-09-17", q = "상점", page = "999", pageSize = "1"),
                null,
            ).bytes,
        )
        val empty = json(reader().destinations(query(q = "not-found", page = "999"), null).bytes)

        assertThat(first.get("total").asInt()).isEqualTo(3)
        assertThat(first.get("pageCount").asInt()).isEqualTo(3)
        assertThat(first.get("summary")).isEqualTo(mapper.readTree("""{"destinations":3,"orders":6,"boxes":15}"""))
        assertThat(first.at("/items/0/name").asString()).isEqualTo("가상점 주소")
        assertThat(second.at("/items/0/name").asString()).isEqualTo(",나상점")
        assertThat(second.at("/items/0/regionNames")).isEqualTo(mapper.readTree("""["경기","서울"]"""))
        assertThat(second.at("/items/0/orderDays").asInt()).isEqualTo(2)
        assertThat(clamped.get("page").asInt()).isEqualTo(3)
        assertThat(clamped.at("/items/0/name").asString()).isEqualTo("다상점")
        assertThat(empty.get("total").asInt()).isZero()
        assertThat(empty.get("page").asInt()).isEqualTo(1)
        assertThat(empty.get("pageCount").asInt()).isEqualTo(1)
        assertThat(empty.get("items").isEmpty).isTrue()
        assertThat(empty.get("summary")).isEqualTo(mapper.readTree("""{"destinations":2,"orders":3,"boxes":7}"""))
    }

    @Test
    fun `matches Node Korean numeric punctuation ordering and uses id fallback for equal values`() {
        Files.writeString(directory.resolve("manifest.json"), NUMERIC_MANIFEST)
        Files.writeString(directory.resolve("destinations.json"), NUMERIC_CATALOG)

        val items = json(reader().destinations(query(date = "2025-09-17"), null).bytes).get("items")
        val names = (0 until items.size()).map { index -> items.get(index).get("name").asString() }

        assertThat(names).isEqualTo(
            listOf("1 층", "1, 2층", "1,2층", "1.2.3층", "상점001", "상점1", "상점2", "상점10"),
        )
    }

    @Test
    fun `validates every query bound before reading a catalog`() {
        Files.delete(directory.resolve("destinations.json"))
        val invalid = listOf(
            query(date = "2025-09-16"),
            query(page = "0"),
            query(page = "-1"),
            query(page = "1000001"),
            query(pageSize = "101"),
            query(q = "x".repeat(101)),
        )

        invalid.forEach { query -> assertError("DISPATCH_DATA_QUERY_INVALID") { reader().destinations(query, null) } }
        assertError("DISPATCH_DATA_NOT_FOUND") { reader().destinations(query(), null) }
    }

    @Test
    fun `rejects catalog source drift duplicates and malformed daily totals`() {
        val invalidCatalogs = listOf(
            CATALOG.replace(MANIFEST_SIGNATURE, "0".repeat(64)),
            CATALOG.replace("\"id\":\"dst_a\"", "\"id\":\"dst_b\""),
            CATALOG.replace("\"orderCount\":1", "\"orderCount\":-1"),
            CATALOG.replace("\"boxCount\":4", "\"boxCount\":null"),
            CATALOG.replace(
                "\"date\":\"2025-09-17\",\"regionNames\":[\"경기\"]",
                "\"date\":\"2025-09-15\",\"regionNames\":[\"경기\"]",
            ),
        )

        invalidCatalogs.forEach { value ->
            Files.writeString(directory.resolve("destinations.json"), value)
            assertError("DISPATCH_DATA_INVALID") { reader().destinations(query(), null) }
        }

        Files.writeString(directory.resolve("destinations.json"), "$CATALOG{}")
        assertError("DISPATCH_DATA_INVALID") { reader().destinations(query(), null) }
    }

    @Test
    fun `invalidates the one-entry catalog cache when the manifest date set changes`() {
        val reader = reader()
        assertThat(json(reader.destinations(query(), null).bytes).get("total").asInt()).isEqualTo(2)
        Files.writeString(
            directory.resolve("manifest.json"),
            MANIFEST.replace(
                "{\"date\":\"2025-09-17\",\"orderCount\":3}",
                "{\"date\":\"2025-09-17\",\"orderCount\":3},{\"date\":\"2025-09-18\",\"orderCount\":1}",
            ),
        )

        assertError("DISPATCH_DATA_INVALID") { reader.destinations(query(), null) }
    }

    @Test
    fun `matches source date shift signatures and provides gzip representation etags`() {
        Files.writeString(directory.resolve("manifest.json"), SHIFTED_MANIFEST)
        Files.writeString(directory.resolve("destinations.json"), SHIFTED_CATALOG)
        val reader = reader()

        val plain = reader.destinations(query(), null)
        val compressed = reader.destinations(query(), "br, gzip")
        val rejected = reader.destinations(query(), "gzip;q=0, *;q=1")

        assertThat(compressed.contentEncoding).isEqualTo("gzip")
        assertThat(compressed.varyAcceptEncoding).isTrue()
        assertThat(compressed.etag).isNotEqualTo(plain.etag)
        assertThat(GZIPInputStream(compressed.bytes.inputStream()).readAllBytes()).isEqualTo(plain.bytes)
        assertThat(rejected.contentEncoding).isNull()
        assertThat(rejected.bytes).isEqualTo(plain.bytes)
    }

    private fun reader() = DestinationCatalogReader(LegacySettings(URI("http://127.0.0.1:1"), directory))

    private fun query(
        date: String? = null,
        q: String? = null,
        page: String? = null,
        pageSize: String? = null,
    ) = DestinationQuery(date, q, page, pageSize)

    private fun json(bytes: ByteArray): JsonNode = mapper.readTree(bytes)

    private fun assertError(code: String, block: () -> Unit) {
        assertThatThrownBy(block)
            .isInstanceOfSatisfying(DispatchDataException::class.java) { error ->
                assertThat(error.code).isEqualTo(code)
            }
    }

    companion object {
        private const val MANIFEST_SIGNATURE = "46c8e36616d9de01b1f469e7cdce4175200836b543716cce36dcba3cf051bf9b"
        private const val SHIFTED_SIGNATURE = "65b4f07d4552db1c17d61dfa1a18fe26082a9908d8beb7506638d41302a78d37"
        private val MANIFEST = """
            {"schemaVersion":1,"defaultDate":"2025-09-15","dates":[{"date":"2025-09-15","orderCount":2},{"date":"2025-09-17","orderCount":3}],"source":{"csvSha256":"fixture-hash"}}
        """.trimIndent()
        private val CATALOG = """
            {"schemaVersion":1,"source":{"csvSha256":"fixture-hash","manifestSignature":"$MANIFEST_SIGNATURE"},"destinations":[
              {"id":"dst_b","name":",나상점","address":"서울 주소","detailAddress":"101호","buyer":"must-not-leak","dates":[{"date":"2025-09-15","regionNames":["서울"],"orderCount":2,"boxCount":3},{"date":"2025-09-17","regionNames":["경기"],"orderCount":1,"boxCount":2}]},
              {"id":"dst_a","name":"-","address":"가상점 주소","detailAddress":"101호","dates":[{"date":"2025-09-15","regionNames":["서울"],"orderCount":1,"boxCount":4}]},
              {"id":"dst_c","name":"다상점","address":"인천 주소","detailAddress":"","dates":[{"date":"2025-09-17","regionNames":["인천"],"orderCount":2,"boxCount":6}]}
            ]}
        """.trimIndent()
        private val EXPECTED_DEFAULT = """
            {"date":"2025-09-15","fromDate":"2025-09-15","total":2,"page":1,"pageSize":20,"pageCount":1,"summary":{"destinations":2,"orders":3,"boxes":7},"items":[
              {"id":"dst_a","name":"가상점 주소","address":"가상점 주소","detailAddress":"101호","regionNames":["서울"],"orderCount":1,"boxCount":4,"orderDays":1,"firstOrderDate":"2025-09-15","lastOrderDate":"2025-09-15"},
              {"id":"dst_b","name":",나상점","address":"서울 주소","detailAddress":"101호","regionNames":["서울"],"orderCount":2,"boxCount":3,"orderDays":1,"firstOrderDate":"2025-09-15","lastOrderDate":"2025-09-15"}
            ]}
        """.trimIndent()
        private val NUMERIC_MANIFEST = MANIFEST
        private val NUMERIC_CATALOG = """
            {"schemaVersion":1,"source":{"csvSha256":"fixture-hash","manifestSignature":"$MANIFEST_SIGNATURE"},"destinations":[
              {"id":"b","name":"상점10","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"a","name":"상점2","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"c","name":"상점001","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"d","name":"상점1","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"e","name":"1 층","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"f","name":"1, 2층","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"g","name":"1,2층","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]},
              {"id":"h","name":"1.2.3층","address":"a","detailAddress":"","dates":[{"date":"2025-09-15","regionNames":[],"orderCount":1,"boxCount":1}]}
            ]}
        """.trimIndent()
        private val SHIFTED_MANIFEST = """
            {"schemaVersion":1,"defaultDate":"2025-09-15","dates":[{"date":"2025-09-15"},{"date":"2025-09-17"}],"source":{"csvSha256":"fixture-hash","dateShift":{"sourceDate":"2025-09-14","operatingDate":"2025-09-15","offsetDays":1}}}
        """.trimIndent()
        private val SHIFTED_CATALOG = """
            {"schemaVersion":1,"source":{"csvSha256":"fixture-hash","manifestSignature":"$SHIFTED_SIGNATURE","dateShift":{"sourceDate":"2025-09-14","operatingDate":"2025-09-15","offsetDays":1}},"destinations":[]}
        """.trimIndent()
    }
}
