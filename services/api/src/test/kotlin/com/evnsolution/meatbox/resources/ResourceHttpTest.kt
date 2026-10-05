package com.evnsolution.meatbox.resources

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
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ResourceHttpTest(
    @param:LocalServerPort private val port: Int,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val mapper = JsonMapper.builder().build()

    @BeforeEach
    fun resetDatabase() {
        Files.deleteIfExists(database)
        createV2Database(database)
    }

    @Test
    fun `authenticates every resource path and marks GET and HEAD responses`() {
        val unauthorized = request("/api/resources")
        assertThat(unauthorized.statusCode()).isEqualTo(401)
        assertThat(unauthorized.body()).isEqualTo("{\"error\":\"LOGIN_REQUIRED\"}")
        assertHeaders(unauthorized)

        val response = request("/api/resources", cookie = VALID_COOKIE)
        assertThat(response.statusCode()).isEqualTo(200)
        assertThat(mapper.readTree(response.body())["revision"].asInt()).isZero()
        assertHeaders(response)

        val head = request("/api/resources", method = "HEAD", cookie = VALID_COOKIE)
        assertThat(head.statusCode()).isEqualTo(200)
        assertThat(head.body()).isEmpty()
        assertHeaders(head)

        assertThat(request("/api/resources/unknown", cookie = VALID_COOKIE).statusCode()).isEqualTo(404)
        assertThat(request("/api/resources/unknown").statusCode()).isEqualTo(401)
    }

    @Test
    fun `preserves region and vehicle mutation contracts with origin and revision CAS`() {
        val wrongOrigin = jsonRequest(
            "/api/resources/region-codes",
            "POST",
            "{\"revision\":0,\"code\":\"NEW\"}",
            origin = "https://evil.invalid",
        )
        assertThat(wrongOrigin.statusCode()).isEqualTo(403)
        assertThat(error(wrongOrigin)).isEqualTo("ORIGIN_REQUIRED")

        val created = jsonRequest(
            "/api/resources/region-codes",
            "POST",
            "{\"revision\":0,\"code\":\"new\"}",
        )
        assertThat(created.statusCode()).isEqualTo(200)
        assertThat(mapper.readTree(created.body())["revision"].asInt()).isEqualTo(1)

        val assigned = jsonRequest(
            "/api/resources/vehicles",
            "PATCH",
            """{"revision":1,"assignments":[{"id":"G1","regionCode":"NEW"},{"id":"G2","regionCode":"NEW"}]}""",
        )
        assertThat(assigned.statusCode()).isEqualTo(200)
        assertThat(mapper.readTree(assigned.body())["revision"].asInt()).isEqualTo(2)

        val renamed = jsonRequest(
            "/api/resources/region-codes/NEW",
            "PATCH",
            "{\"revision\":2,\"code\":\"NEXT\"}",
        )
        assertThat(renamed.statusCode()).isEqualTo(200)
        assertThat(mapper.readTree(renamed.body())["vehicles"].count { it["regionCode"].asString() == "NEXT" })
            .isEqualTo(2)

        val stale = jsonRequest(
            "/api/resources/vehicles/G1",
            "PATCH",
            "{\"revision\":0,\"regionCode\":null}",
        )
        assertThat(stale.statusCode()).isEqualTo(409)
        assertThat(error(stale)).isEqualTo("RESOURCE_REVISION_CONFLICT")
    }

    @Test
    fun `rejects malformed duplicate oversized and structurally invalid JSON without writes`() {
        val inputs = listOf(
            "{" to "INVALID_JSON",
            "{\"revision\":0,\"revision\":0,\"code\":\"NEW\"}" to "INVALID_JSON",
            "[]" to "INVALID_INPUT",
            "{\"revision\":0,\"code\":\"NEW\",\"extra\":true}" to "INVALID_INPUT",
            "{\"revision\":0,\"code\":true}" to "INVALID_REGION_CODE",
            "{\"revision\":9007199254740992,\"code\":\"NEW\"}" to "INVALID_REVISION",
        )
        inputs.forEach { (body, expected) ->
            val response = jsonRequest("/api/resources/region-codes", "POST", body)
            assertThat(response.statusCode()).isEqualTo(400)
            assertThat(error(response)).isEqualTo(expected)
        }

        val assignmentType = jsonRequest(
            "/api/resources/vehicles",
            "PATCH",
            "{\"revision\":0,\"assignments\":[{\"id\":\"G1\",\"regionCode\":true}]}",
        )
        assertThat(error(assignmentType)).isEqualTo("INVALID_REGION_CODE")

        val oversized = jsonRequest(
            "/api/resources/region-codes",
            "POST",
            "{\"padding\":\"${"x".repeat(MAX_BODY_BYTES)}\"}",
        )
        assertThat(oversized.statusCode()).isEqualTo(400)
        assertThat(error(oversized)).isEqualTo("INVALID_JSON")

        val snapshot = request("/api/resources", cookie = VALID_COOKIE)
        assertThat(mapper.readTree(snapshot.body())["revision"].asInt()).isZero()
    }

    @Test
    fun `returns closed unavailable errors for missing corrupt and v1 databases`() {
        Files.delete(database)
        val missing = request("/api/resources", cookie = VALID_COOKIE)
        assertThat(missing.statusCode()).isEqualTo(503)
        assertThat(error(missing)).isEqualTo("RESOURCE_DATABASE_UNAVAILABLE")
        assertThat(missing.body()).doesNotContain(database.toString())
        assertThat(database).doesNotExist()

        Files.writeString(database, "not sqlite")
        val corrupt = request("/api/resources", cookie = VALID_COOKIE)
        assertThat(corrupt.statusCode()).isEqualTo(503)
        assertThat(corrupt.body()).doesNotContain(database.toString())

        Files.delete(database)
        createV1Database(database)
        val before = Files.readAllBytes(database)
        val old = request("/api/resources", cookie = VALID_COOKIE)
        assertThat(old.statusCode()).isEqualTo(503)
        assertThat(Files.readAllBytes(database)).isEqualTo(before)
    }

    private fun jsonRequest(
        path: String,
        method: String,
        body: String,
        origin: String = PUBLIC_ORIGIN,
    ): HttpResponse<String> = request(
        path,
        method,
        VALID_COOKIE,
        body,
        mapOf("Origin" to origin, "Content-Type" to "application/json"),
    )

    private fun request(
        path: String,
        method: String = "GET",
        cookie: String? = null,
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse<String> {
        val publisher = body?.let(HttpRequest.BodyPublishers::ofString) ?: HttpRequest.BodyPublishers.noBody()
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).method(method, publisher)
        cookie?.let { builder.header("Cookie", it) }
        headers.forEach(builder::header)
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun error(response: HttpResponse<String>): String = mapper.readTree(response.body())["error"].asString()

    private fun assertHeaders(response: HttpResponse<String>) {
        assertThat(response.headers().firstValue(ResourceSessionFilter.OWNER_HEADER).orElse("")).isEqualTo("kotlin")
        assertThat(response.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store")
        assertThat(response.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff")
    }

    companion object {
        private const val PUBLIC_ORIGIN = "http://127.0.0.1:4173"
        private const val VALID_COOKIE = "session=valid"
        private const val MAX_BODY_BYTES = 256 * 1024
        private val directory: Path = Files.createTempDirectory("meatbox-resources-http-")
        private val database: Path = directory.resolve("resources.sqlite")
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/session", ::sessionResponse)
            start()
        }

        init {
            createV2Database(database)
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.compat.enabled") { "true" }
            registry.add("meatbox.compat.legacy-api-origin") { "http://127.0.0.1:${sessionServer.address.port}" }
            registry.add("meatbox.compat.dispatch-data-dir") { directory.toString() }
            registry.add("meatbox.resources.enabled") { "true" }
            registry.add("meatbox.resources.database") { database.toString() }
            registry.add("meatbox.resources.public-origin") { PUBLIC_ORIGIN }
        }

        @JvmStatic
        @AfterAll
        fun closeFixtures() {
            sessionServer.stop(0)
            database.toFile().delete()
            directory.toFile().delete()
        }

        private fun sessionResponse(exchange: HttpExchange) {
            val valid = exchange.requestHeaders.getFirst("Cookie") == VALID_COOKIE
            val status = if (valid) 200 else 401
            val body = if (valid) {
                "{\"user\":{\"username\":\"fixture-user\"}}"
            } else {
                "{\"error\":\"LOGIN_REQUIRED\"}"
            }.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(status, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
    }
}
