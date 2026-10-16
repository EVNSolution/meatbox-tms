package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.resources.createV2Database
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.time.temporal.ChronoUnit

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TemperatureHttpTest(
    @param:LocalServerPort private val port: Int,
    @param:Autowired private val alerts: ErrorAlerts,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = JsonMapper.builder().build()

    private fun at(secondsAgo: Long): String =
        Instant.now().minusSeconds(secondsAgo).truncatedTo(ChronoUnit.SECONDS).toString()

    private fun body(vehicle: String, sensor: String, vararg readings: Pair<String, Double>) =
        """{"vehicleId":"$vehicle","sensorId":"$sensor","measurements":[${
            readings.joinToString(",") { """{"measuredAt":"${it.first}","celsius":${it.second}}""" }
        }]}"""

    @Test
    fun `refuses a missing or wrong token with problem json and stores nothing`() {
        for (header in listOf(null, "Bearer wrong-token-wrong-token", "Basic $TOKEN", TOKEN)) {
            val response = post(body("T-DENIED", "S", at(60) to -18.0), authorization = header)
            assertThat(response.statusCode()).describedAs("$header").isEqualTo(401)
            assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
            assertThat(response.headers().firstValue("WWW-Authenticate").orElse("")).isEqualTo("Bearer")
            assertProblem(response.body(), 401, "TELEMETRY_UNAUTHORIZED")
        }
        assertThat(Files.exists(stateDirectory.resolve("telemetry/T-DENIED"))).isFalse()
        // The inbound order token does not open this route either.
        assertThat(post(body("T-DENIED", "S", at(60) to -18.0), authorization = "Bearer $INBOUND").statusCode())
            .isEqualTo(401)
    }

    @Test
    fun `stores a batch, answers a resend without storing it again and warns once about an unregistered vehicle`() {
        val sent = body("T-ONE", "S-1", at(90) to -18.4, at(60) to -18.1)
        val first = post(sent, key = "batch-1")
        assertThat(first.statusCode()).isEqualTo(202)
        val receipt = json.readTree(first.body())
        assertThat(receipt.path("accepted").asInt()).isEqualTo(2)
        assertThat(receipt.path("duplicate").asInt()).isZero()
        assertThat(receipt.path("unknownVehicle").asBoolean()).isTrue()

        val resend = json.readTree(post(sent, key = "batch-1").body())
        assertThat(resend.path("accepted").asInt()).isZero()
        assertThat(resend.path("duplicate").asInt()).isEqualTo(2)

        val known = json.readTree(post(body("G1", "S-1", at(60) to 3.0)).body())
        assertThat(known.path("unknownVehicle").asBoolean()).isFalse()
        assertThat(alerts.recent().filter { it.subject.contains("UNKNOWN_VEHICLE") }).hasSize(1)
        val lines = Files.walk(stateDirectory.resolve("telemetry/T-ONE")).use { files ->
            files.filter { it.toString().endsWith(".jsonl") }.flatMap { Files.readAllLines(it).stream() }.toList()
        }
        assertThat(lines).hasSize(2)
    }

    @Test
    fun `checks key, media type, size and body before storing`() {
        val good = body("T-BAD", "S", at(60) to -18.0)
        assertProblem(post(good, key = "bad key!").body(), 400, "INVALID_IDEMPOTENCY_KEY")
        assertProblem(post(good, contentType = "text/plain").body(), 415, "INVALID_TELEMETRY")
        assertProblem(post("[]").body(), 400, "INVALID_TELEMETRY")
        assertProblem(post("""{"vehicleId":"T-BAD"""").body(), 400, "INVALID_TELEMETRY")
        assertProblem(post(body("T-BAD", "S", at(60) to 61.0)).body(), 400, "TEMPERATURE_OUT_OF_BOUNDS")
        assertProblem(post(body("T-BAD", "S", at(-600) to -18.0)).body(), 400, "MEASURED_AT_FUTURE")
        val huge = post("""{"pad":"${"x".repeat(140_000)}"}""")
        assertThat(huge.statusCode()).isEqualTo(413)
        assertProblem(huge.body(), 413, "TELEMETRY_TOO_LARGE")
        assertThat(Files.exists(stateDirectory.resolve("telemetry/T-BAD"))).isFalse()
    }

    @Test
    fun `reading needs the login session and answers latest and history`() {
        val readings = body("T-READ", "S-1", at(240) to -18.0, at(200) to -17.0, at(30) to -16.0)
        assertThat(post(readings).statusCode()).isEqualTo(202)
        assertThat(post(body("T-READ", "S-1", at(240) to -18.0)).statusCode()).isEqualTo(202)

        assertProblem(get("/api/telemetry/temperature/latest", cookie = null).body(), 401, "LOGIN_REQUIRED")
        val history = "/api/telemetry/temperature/T-READ?from=${enc(at(300))}"
        assertProblem(get(history, cookie = null).body(), 401, "LOGIN_REQUIRED")

        val latest = json.readTree(get("/api/telemetry/temperature/latest").body()).path("vehicles").toList()
            .single { it.path("vehicleId").asString() == "T-READ" }
        assertThat(latest.path("celsius").doubleValue()).isEqualTo(-16.0)
        assertThat(latest.path("sensorId").asString()).isEqualTo("S-1")
        assertThat(latest.path("stale").asBoolean()).isFalse()
        assertThat(latest.path("outOfRange").asBoolean()).isFalse()
        assertThat(latest.path("range").isNull).isTrue()
        assertThat(latest.path("ageSeconds").asLong()).isLessThan(30)

        val raw = json.readTree(get("/api/telemetry/temperature/T-READ?from=${enc(at(300))}").body())
        assertThat(raw.path("measurements").toList().map { it.path("celsius").doubleValue() })
            .containsExactly(-18.0, -17.0, -16.0)
        assertThat(raw.path("truncated").asBoolean()).isFalse()
        val minutes = json.readTree(get("/api/telemetry/temperature/T-READ?from=${enc(at(300))}&resolution=1m").body())
        assertThat(minutes.path("measurements").toList().sumOf { it.path("count").asInt() }).isEqualTo(3)
    }

    @Test
    fun `refuses a range over 24 hours, a backwards range and unsafe names`() {
        fun code(path: String) = get(path)
        val from = enc(at(90_000))
        assertProblem(code("/api/telemetry/temperature/T-READ?from=$from").body(), 400, "INVALID_RANGE")
        val backwards = "/api/telemetry/temperature/T-READ?from=${enc(at(10))}&to=${enc(at(60))}"
        assertProblem(code(backwards).body(), 400, "INVALID_RANGE")
        assertProblem(code("/api/telemetry/temperature/T-READ?from=yesterday").body(), 400, "INVALID_RANGE")
        val coarse = "/api/telemetry/temperature/T-READ?from=${enc(at(60))}&resolution=5m"
        assertProblem(code(coarse).body(), 400, "INVALID_RESOLUTION")
        assertProblem(code("/api/telemetry/temperature/a%20b?from=${enc(at(60))}").body(), 400, "INVALID_VEHICLE")
        assertThat(code("/api/telemetry/temperature/..%2Fx?from=${enc(at(60))}").statusCode()).isEqualTo(400)
        assertThat(get("/api/telemetry/temperature/T-NONE?from=${enc(at(60))}").statusCode()).isEqualTo(200)
    }

    private fun enc(value: String) = URLEncoder.encode(value, Charsets.UTF_8)

    private fun post(
        body: String,
        key: String? = null,
        contentType: String = "application/json",
        authorization: String? = "Bearer $TOKEN",
    ): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/telemetry/temperature"))
            .header("Content-Type", contentType).POST(HttpRequest.BodyPublishers.ofString(body))
        key?.let { builder.header("Idempotency-Key", it) }
        authorization?.let { builder.header("Authorization", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun get(path: String, cookie: String? = COOKIE): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
        cookie?.let { builder.header("Cookie", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    companion object {
        private const val TOKEN = "telemetry-token-for-tests"
        private const val INBOUND = "inbound-token-for-tests"
        private const val COOKIE = "session=valid"
        private const val ORIGIN = "http://127.0.0.1:4173"
        private val directory: Path = Files.createTempDirectory("meatbox-telemetry-http-").toRealPath()
        private val dataDirectory: Path = Files.createDirectories(directory.resolve("data"))
        private val stateDirectory: Path = Files.createDirectory(directory.resolve("state"))
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/session") { exchange: HttpExchange ->
                val valid = exchange.requestHeaders.getFirst("Cookie") == COOKIE
                val body = (if (valid) """{"user":{"username":"fixture-user"}}""" else """{"error":"LOGIN_REQUIRED"}""")
                    .toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(if (valid) 200 else 401, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
        }

        init {
            Files.createDirectories(dataDirectory.resolve("days"))
            Files.writeString(
                dataDirectory.resolve("manifest.json"),
                """{"schemaVersion":1,"defaultDate":"2026-10-05","dates":[{"date":"2026-10-05"}],""" +
                    """"source":{"csvSha256":"x"}}""",
            )
            Files.writeString(dataDirectory.resolve("days/2026-10-05.json"), """{"date":"2026-10-05","orders":[]}""")
            createV2Database(directory.resolve("resources.sqlite"))
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.compat.enabled") { "true" }
            registry.add("meatbox.compat.legacy-api-origin") { "http://127.0.0.1:${sessionServer.address.port}" }
            registry.add("meatbox.compat.dispatch-data-dir") { dataDirectory.toString() }
            registry.add("meatbox.dispatch.enabled") { "true" }
            registry.add("meatbox.dispatch.state-dir") { stateDirectory.toString() }
            registry.add("meatbox.dispatch.public-origin") { ORIGIN }
            registry.add("meatbox.inbound.token") { INBOUND }
            registry.add("meatbox.telemetry.token") { TOKEN }
            registry.add("meatbox.resources.enabled") { "true" }
            registry.add("meatbox.resources.database") { directory.resolve("resources.sqlite").toString() }
            registry.add("meatbox.resources.public-origin") { ORIGIN }
        }

        @JvmStatic
        @AfterAll
        fun closeFixtures() {
            sessionServer.stop(0)
            directory.toFile().deleteRecursively()
        }
    }
}
