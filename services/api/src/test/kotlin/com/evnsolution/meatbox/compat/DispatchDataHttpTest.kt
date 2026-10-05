package com.evnsolution.meatbox.compat

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPOutputStream

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DispatchDataHttpTest(
    @param:LocalServerPort private val port: Int,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()

    @BeforeEach
    fun resetSessionHits() {
        sessionHits.set(0)
        sessionMode.set("normal")
    }

    @Test
    fun `authenticates before returning raw source bytes`() {
        val unauthorized = request("/api/dispatch-data/manifest")
        assertThat(unauthorized.statusCode()).isEqualTo(401)
        assertThat(unauthorized.body().decodeToString()).isEqualTo("{\"error\":\"LOGIN_REQUIRED\"}")
        assertThat(unauthorized.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
            .isEqualTo("kotlin")
        assertThat(unauthorized.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store")
        assertThat(unauthorized.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff")

        val response = request("/api/dispatch-data/manifest", cookie = "session=valid")
        assertThat(response.statusCode()).isEqualTo(200)
        assertThat(response.body()).isEqualTo(manifest)
        assertThat(response.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
            .isEqualTo("kotlin")
        assertThat(response.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store")
        assertThat(response.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff")
        assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/json")
        assertThat(sessionHits.get()).isEqualTo(2)
    }

    @Test
    fun `supports head gzip and conditional get without changing the source representation`() {
        val plain = request("/api/dispatch-data/days/$DATE", cookie = "session=valid")
        val etag = plain.headers().firstValue("ETag").orElseThrow()

        val head = request("/api/dispatch-data/days/$DATE", "HEAD", "session=valid")
        assertThat(head.statusCode()).isEqualTo(200)
        assertThat(head.body()).isEmpty()
        assertThat(head.headers().firstValueAsLong("Content-Length").orElseThrow()).isEqualTo(day.size.toLong())

        val compressed = request(
            "/api/dispatch-data/days/$DATE",
            cookie = "session=valid",
            headers = mapOf("Accept-Encoding" to "gzip"),
        )
        assertThat(compressed.statusCode()).isEqualTo(200)
        assertThat(compressed.headers().firstValue("Content-Encoding").orElse(null)).isEqualTo("gzip")
        assertThat(compressed.body()).isEqualTo(dayGzip)

        val unchanged = request(
            "/api/dispatch-data/days/$DATE",
            cookie = "session=valid",
            headers = mapOf("If-None-Match" to etag),
        )
        assertThat(unchanged.statusCode()).isEqualTo(304)
        assertThat(unchanged.body()).isEmpty()
    }

    @Test
    fun `protects destination snapshots and supports head gzip etag and duplicate query rejection`() {
        val unauthorized = request("/api/dispatch-data/destinations")
        assertThat(unauthorized.statusCode()).isEqualTo(401)
        assertThat(unauthorized.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
            .isEqualTo("kotlin")

        val plain = request("/api/dispatch-data/destinations", cookie = "session=valid")
        val etag = plain.headers().firstValue("ETag").orElseThrow()
        assertThat(plain.statusCode()).isEqualTo(200)
        assertThat(plain.body().decodeToString()).contains("\"destinations\":1", "\"name\":\"상점2\"")
        assertThat(plain.headers().firstValue("Vary").orElse("")).isEqualTo("Accept-Encoding")
        assertThat(plain.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
            .isEqualTo("kotlin")

        val head = request("/api/dispatch-data/destinations", "HEAD", "session=valid")
        assertThat(head.statusCode()).isEqualTo(200)
        assertThat(head.body()).isEmpty()
        assertThat(head.headers().firstValueAsLong("Content-Length").orElseThrow())
            .isEqualTo(plain.body().size.toLong())

        val compressed = request(
            "/api/dispatch-data/destinations",
            cookie = "session=valid",
            headers = mapOf("Accept-Encoding" to "gzip"),
        )
        assertThat(compressed.headers().firstValue("Content-Encoding").orElse("")).isEqualTo("gzip")

        val unchanged = request(
            "/api/dispatch-data/destinations",
            cookie = "session=valid",
            headers = mapOf("If-None-Match" to etag),
        )
        assertThat(unchanged.statusCode()).isEqualTo(304)
        assertThat(unchanged.body()).isEmpty()

        for (query in listOf("?q=x&q=y", "?date=$DATE&date=$DATE", "?page=1&page=2", "?pageSize=1&pageSize=2")) {
            val duplicate = request("/api/dispatch-data/destinations$query", cookie = "session=valid")
            assertThat(duplicate.statusCode()).isEqualTo(400)
            assertThat(duplicate.body().decodeToString()).contains("DISPATCH_DATA_QUERY_INVALID")
        }
    }

    @Test
    fun `keeps invalid and non allowlisted dates inside the not found contract`() {
        for (date in listOf("2026-02-30", "2026-10-06")) {
            val response = request("/api/dispatch-data/days/$date", cookie = "session=valid")
            assertThat(response.statusCode()).isEqualTo(404)
            assertThat(response.body().decodeToString()).contains("DISPATCH_DATA_NOT_FOUND")
            assertThat(response.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
                .isEqualTo("kotlin")
        }
    }

    @Test
    fun `returns a marked unavailable response when the legacy session response is malformed`() {
        sessionMode.set("malformed")

        val response = request("/api/dispatch-data/manifest", cookie = "session=valid")

        assertThat(response.statusCode()).isEqualTo(503)
        assertThat(response.body().decodeToString()).isEqualTo("{\"error\":\"LEGACY_SESSION_UNAVAILABLE\"}")
        assertThat(response.headers().firstValue(LegacySessionFilter.SOURCE_READER_HEADER).orElse(""))
            .isEqualTo("kotlin")
        assertThat(response.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store")
        assertThat(response.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff")
    }

    @Test
    fun `does not authenticate or implement state commands and other methods`() {
        val state = request("/api/dispatch-data/days/$DATE/state", cookie = "session=valid")
        val post = request("/api/dispatch-data/manifest", method = "POST", cookie = "session=valid")

        assertThat(state.statusCode()).isEqualTo(404)
        assertThat(post.statusCode()).isEqualTo(405)
        assertThat(sessionHits.get()).isZero()
    }

    private fun request(
        path: String,
        method: String = "GET",
        cookie: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse<ByteArray> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
            .method(method, HttpRequest.BodyPublishers.noBody())
        cookie?.let { builder.header("Cookie", it) }
        headers.forEach(builder::header)
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
    }

    companion object {
        private const val DATE = "2026-10-05"
        private val sessionHits = AtomicInteger()
        private val sessionMode = AtomicReference("normal")
        private val directory: Path = Files.createTempDirectory("meatbox-kotlin-http-")
        private val manifest = """
            { "schemaVersion": 1, "defaultDate": "$DATE", "unknown": {"preserved": true},
              "dates": [{"date":"$DATE","weekday":"월요일"}] }
        """.trimIndent().toByteArray()
        private val day = "{\"date\":\"$DATE\",\"orders\":[]}\n".toByteArray()
        private val dayGzip = gzip(day)
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/session", ::sessionResponse)
            start()
        }

        init {
            Files.createDirectories(directory.resolve("days"))
            Files.write(directory.resolve("manifest.json"), manifest)
            Files.write(directory.resolve("days/$DATE.json"), day)
            Files.write(directory.resolve("days/$DATE.json.gz"), dayGzip)
            Files.writeString(directory.resolve("regions.geojson"), "{\"type\":\"FeatureCollection\",\"features\":[]}")
            Files.writeString(
                directory.resolve("destinations.json"),
                """
                    {"schemaVersion":1,
                     "source":{"manifestSignature":"6a5fa66ce2280fabcb1d73fe6c853b6eff5c34dfdd68aea32683ea9f7969e970"},
                     "destinations":[{"id":"a","name":"상점2","address":"서울","detailAddress":"",
                     "dates":[{"date":"$DATE","regionNames":["서울"],"orderCount":1,"boxCount":2}]}]}
                """.trimIndent(),
            )
        }

        @JvmStatic
        @DynamicPropertySource
        fun compatProperties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.compat.enabled") { "true" }
            registry.add("meatbox.compat.legacy-api-origin") { "http://127.0.0.1:${sessionServer.address.port}" }
            registry.add("meatbox.compat.dispatch-data-dir") { directory.toString() }
        }

        @JvmStatic
        @AfterAll
        fun stopSessionServer() {
            sessionServer.stop(0)
        }

        private fun sessionResponse(exchange: HttpExchange) {
            sessionHits.incrementAndGet()
            val valid = exchange.requestHeaders.getFirst("Cookie") == "session=valid"
            val status = if (valid) 200 else 401
            val body = (if (sessionMode.get() == "malformed") {
                "{"
            } else if (valid) {
                "{\"user\":{\"username\":\"fixture-user\"}}"
            } else {
                "{\"error\":\"LOGIN_REQUIRED\"}"
            }).toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(status, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }

        private fun gzip(bytes: ByteArray): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            GZIPOutputStream(output).use { it.write(bytes) }
            return output.toByteArray()
        }
    }
}
