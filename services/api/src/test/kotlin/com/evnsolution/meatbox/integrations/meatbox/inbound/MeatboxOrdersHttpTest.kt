package com.evnsolution.meatbox.integrations.meatbox.inbound

import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.ops.ErrorAlerts
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
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDate
import java.time.ZoneId

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MeatboxOrdersHttpTest(
    @param:LocalServerPort private val port: Int,
    @param:Autowired private val alerts: ErrorAlerts,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = JsonMapper.builder().build()

    @Test
    fun `refuses a missing or wrong token with problem json and never reaches the orders`() {
        for (header in listOf(null, "Bearer wrong-token-wrong-token", "Basic $TOKEN", TOKEN)) {
            val response = post("A", 1, authorization = header)
            assertThat(response.statusCode()).describedAs("$header").isEqualTo(401)
            assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
            assertThat(response.headers().firstValue("WWW-Authenticate").orElse("")).isEqualTo("Bearer")
            assertProblem(response.body(), 401, "INBOUND_UNAUTHORIZED")
        }
        val ids = state().path("dispatchOrders").toList().map { it.path("id").asString() }
        assertThat(ids).doesNotContain("A")
    }

    @Test
    fun `checks the key, the body and the media type`() {
        val key = post("A", 1, key = "A:2")
        assertThat(key.statusCode()).isEqualTo(400)
        assertProblem(key.body(), 400, "IDEMPOTENCY_KEY_MISMATCH")
        assertProblem(post("A", 1, key = null).body(), 400, "IDEMPOTENCY_KEY_MISMATCH")
        val broken = send("/api/meatbox/orders", """{"orderId":"A","version":1}""", "A:1", "application/json")
        assertThat(broken.statusCode()).isEqualTo(400)
        assertProblem(broken.body(), 400, "INVALID_ORDER")
        assertProblem(send("/api/meatbox/orders", "[]", "A:1", "application/json").body(), 400, "INVALID_ORDER")
        val text = send("/api/meatbox/orders", "{}", "A:1", "text/plain")
        assertThat(text.statusCode()).isEqualTo(415)
        assertProblem(text.body(), 415, "INVALID_ORDER")
        val huge = send("/api/meatbox/orders", """{"pad":"${"x".repeat(1_100_000)}"}""", "A:1", "application/json")
        assertThat(huge.statusCode()).isEqualTo(413)
        assertProblem(huge.body(), 413, "ORDER_TOO_LARGE")
    }

    @Test
    fun `accepts orders, answers repeats and older versions with 200 and refuses a changed body`() {
        val first = post("H1", 2)
        assertThat(first.statusCode()).isEqualTo(202)
        val receipt = json.readTree(first.body())
        assertThat(receipt.path("accepted").asBoolean()).isTrue()
        assertThat(receipt.path("duplicate").asBoolean()).isFalse()
        assertThat(receipt.path("applied").asBoolean()).isTrue()
        assertThat(receipt.path("sourceId").asString()).startsWith("api-")

        val repeat = post("H1", 2)
        assertThat(repeat.statusCode()).isEqualTo(200)
        assertThat(json.readTree(repeat.body()).path("duplicate").asBoolean()).isTrue()
        val older = post("H1", 1)
        assertThat(older.statusCode()).isEqualTo(200)
        assertThat(json.readTree(older.body()).path("ignored").asBoolean()).isTrue()
        val conflict = post("H1", 2, boxes = 9)
        assertThat(conflict.statusCode()).isEqualTo(409)
        assertProblem(conflict.body(), 409, "ORDER_VERSION_CONFLICT")
        assertThat(state().path("dispatchOrders").toList().map { it.path("id").asString() }).contains("H1")
    }

    @Test
    fun `new orders move the state tag, and a confirmed day keeps its orders and alerts once per kind`() {
        assertThat(post("S0", 1).statusCode()).isEqualTo(202)
        val before = get("/api/dispatch-data/days/$DATE/state")
        val tag = before.headers().firstValue("ETag").orElseThrow()
        assertThat(post("S1", 1).statusCode()).isEqualTo(202)
        assertThat(post("S2", 1).statusCode()).isEqualTo(202)
        val stale = get("/api/dispatch-data/days/$DATE/state", ifNoneMatch = tag)
        assertThat(stale.statusCode()).isEqualTo(200)
        assertThat(stale.headers().firstValue("ETag").orElseThrow()).isNotEqualTo(tag)

        val boot = json.readTree(stale.body()).path("boot").asString()
        assertThat(command("""{"type":"calculate_dispatch","expectedBoot":"$boot","expectedRevision":0,
            "vehicleIds":["api-g01","api-g02"]}""").statusCode()).isEqualTo(200)
        val revision = json.readTree(get("/api/dispatch-data/days/$DATE/state").body()).path("revision").asLong()
        assertThat(command("""{"type":"publish_dispatch","expectedBoot":"$boot","expectedRevision":$revision,
            "draftVersion":$revision}""").statusCode()).isEqualTo(200)
        val confirmed = json.readTree(get("/api/dispatch-data/days/$DATE/state").body())
        assertThat(confirmed.path("dispatch").path("phase").asString()).isEqualTo("published")
        val orderIds = confirmed.path("dispatchOrders").toList().map { it.path("id").asString() }

        val cancelled = json.readTree(post("S1", 2, status = "cancelled").body())
        assertThat(cancelled.path("applied").asBoolean()).isFalse()
        assertThat(cancelled.path("held").asString()).isEqualTo("ORDER_CANCELLED_AFTER_DISPATCH")
        assertThat(post("S2", 2, status = "cancelled").statusCode()).isEqualTo(202)

        val after = json.readTree(get("/api/dispatch-data/days/$DATE/state").body())
        assertThat(after.path("dispatchOrders").toList().map { it.path("id").asString() }).isEqualTo(orderIds)
        assertThat(after.path("dispatch").path("phase").asString()).isEqualTo("published")
        val warnings = after.path("sourceData").path("inbound").path("warnings").toList()
        val codes = warnings.map { it.path("code").asString() }
        assertThat(codes).containsExactly("ORDER_CANCELLED_AFTER_DISPATCH", "ORDER_CANCELLED_AFTER_DISPATCH")
        // Two cancellations in one window are one alert; the window keeps the count.
        val sent = alerts.recent().filter { it.subject.contains("ORDER_CANCELLED_AFTER_DISPATCH") }
        assertThat(sent).hasSize(1)
    }

    private fun state(): JsonNode = json.readTree(get("/api/dispatch-data/days/$DATE/state").body())

    private fun body(id: String, version: Int, status: String, boxes: Int): String =
        if (status == "cancelled") {
            """{"orderId":"$id","version":$version,"status":"cancelled","deliveryDate":"$DATE"}"""
        } else {
            """{"orderId":"$id","version":$version,"status":"active","deliveryDate":"$DATE","deliveryType":"fresh",
            "customer":{"name":"가게 $id","phone":"010-0000-0000"},
            "address":{"road":"서울 강남구 $id","detail":"","lat":null,"lng":null},
            "items":[{"sku":"PK-001","name":"삼겹살","qty":3,"boxes":$boxes}]}"""
        }

    private fun post(
        id: String,
        version: Int,
        status: String = "active",
        boxes: Int = 1,
        key: String? = "$id:$version",
        authorization: String? = "Bearer $TOKEN",
    ): HttpResponse<String> =
        send("/api/meatbox/orders", body(id, version, status, boxes), key, "application/json", authorization)

    private fun send(
        path: String,
        body: String,
        key: String?,
        contentType: String,
        authorization: String? = "Bearer $TOKEN",
    ): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
            .header("Content-Type", contentType).POST(HttpRequest.BodyPublishers.ofString(body))
        key?.let { builder.header("Idempotency-Key", it) }
        authorization?.let { builder.header("Authorization", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun get(path: String, ifNoneMatch: String? = null): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).header("Cookie", COOKIE)
        ifNoneMatch?.let { builder.header("If-None-Match", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun command(body: String): HttpResponse<String> = client.send(
        HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/dispatch-data/days/$DATE/commands"))
            .header("Cookie", COOKIE).header("Origin", ORIGIN).header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    companion object {
        private const val TOKEN = "inbound-token-for-tests"
        private const val COOKIE = "session=valid"
        private const val ORIGIN = "http://127.0.0.1:4173"
        private val DATE: String = LocalDate.now(ZoneId.of("Asia/Seoul")).plusDays(1).toString()
        private val directory: Path = Files.createTempDirectory("meatbox-inbound-http-").toRealPath()
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
            registry.add("meatbox.inbound.token") { TOKEN }
            registry.add("meatbox.inbound.group-count") { "3" }
        }

        @JvmStatic
        @AfterAll
        fun closeFixtures() {
            sessionServer.stop(0)
            directory.toFile().deleteRecursively()
        }
    }
}
