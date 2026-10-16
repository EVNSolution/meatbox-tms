package com.evnsolution.meatbox

import com.evnsolution.meatbox.resources.createV2Database
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path

/**
 * Every business module is enabled at once so that the checks cover the real filter chain.
 * The unauthenticated requests below must never return business data, whatever the spelling.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ApiPathGuardHttpTest(
    @param:LocalServerPort private val port: Int,
    @param:Autowired @param:Qualifier("requestMappingHandlerMapping")
    private val mappings: RequestMappingHandlerMapping,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()

    @Test
    fun `requires a login on every registered api route`() {
        val routes = registeredApiRoutes()
        assertThat(routes.map { it.second }).contains(
            "/api/dispatch-data/manifest",
            "/api/resources",
            "/api/dispatch-data/days/$DATE/state",
            "/api/dispatch-data/days/$DATE/commands",
        )
        for ((method, path) in routes) {
            val response = send(method, path)
            assertThat(response.statusCode()).describedAs("$method $path").isEqualTo(401)
            assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
            if (method != "HEAD") {
                assertProblem(response.body(), 401, "LOGIN_REQUIRED")
            }
        }
    }

    @Test
    fun `answers unknown paths in problem format through the real server`() {
        val response = send("GET", "/api/does-not-exist")
        assertThat(response.statusCode()).isEqualTo(404)
        assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
        assertProblem(response.body(), 404, "NOT_FOUND")
    }

    @Test
    fun `rejects path parameters before the session check and the controller see them`() {
        val spellings = listOf(
            "/api/dispatch-data/manifest;x=1",
            "/api/dispatch-data/regions;x=1",
            "/api/dispatch-data/destinations;x=1",
            "/api/dispatch-data/days/$DATE;x=1",
            "/api/dispatch-data/days/$DATE/state;x=1",
            "/api/dispatch-data/days/$DATE;x=1/state",
            "/api/dispatch-data/days/$DATE/commands;x=1",
            "/api/resources;x=1",
            "/api/resources/;x=1",
            "/api/resources/region-codes;x=1",
            "/api;x=1/resources",
            "/;x=1/api/resources",
            "/api/resources;",
            "/api/resources%3Bx=1",
            "/api/resources%3bx=1",
            "/api/session;x=1",
        )
        for (cookie in listOf(null, VALID_COOKIE)) {
            for (path in spellings) {
                for (method in listOf("GET", "HEAD", "POST", "PATCH")) {
                    val response = send(method, path, cookie)
                    val label = "$method $path cookie=$cookie"
                    assertThat(response.statusCode()).describedAs(label).isEqualTo(400)
                    if (method != "HEAD") {
                        assertProblem(response.body(), 400, "INVALID_PATH")
                    }
                }
            }
        }
    }

    @Test
    fun `never returns business data for other unauthenticated spellings`() {
        val spellings = listOf(
            "//api/resources",
            "/api//resources",
            "/api/./resources",
            "/api/resources/",
            "/api/resources/.",
            "/API/resources",
            "/api/Resources",
            "/api/resources%2f",
            "/api/dispatch-data//manifest",
            "/api/dispatch-data/manifest/",
            "/api/dispatch-data/days/$DATE/state/",
            "/api/dispatch-data/days/$DATE//state",
            "/api/dispatch-data/days/$DATE/state%2f",
            "/api/dispatch-data/days/%32026-10-05/state",
            "/api/dispatch-data/days/$DATE/STATE",
            "/api/dispatch-data/days/$DATE.json",
            "/api/resources?x=1",
            "/api/dispatch-data/manifest?x=1#y",
        )
        for (path in spellings) {
            val response = send("GET", path)
            val label = "GET $path"
            assertThat(response.statusCode()).describedAs(label).isIn(400, 401, 404, 405)
            assertThat(response.body()).describedAs(label).doesNotContain(
                "\"dates\"",
                "\"vehicles\"",
                "\"regionCodes\"",
                "fleetVehicles",
                "\"orders\"",
            )
        }
    }

    private fun registeredApiRoutes(): List<Pair<String, String>> =
        mappings.handlerMethods.keys.flatMap { info ->
            val patterns = info.pathPatternsCondition?.patternValues.orEmpty()
            val methods = info.methodsCondition.methods.map { it.name }.ifEmpty { listOf("GET") }
            patterns.filter { it.startsWith("/api/") }.flatMap { pattern ->
                methods.map { method -> method to pattern.replace(PATH_VARIABLE, DATE) }
            }
        }.distinct()

    private fun send(method: String, path: String, cookie: String? = null): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
            .method(method, HttpRequest.BodyPublishers.noBody())
        cookie?.let { builder.header("Cookie", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    companion object {
        private const val DATE = "2026-10-05"
        private const val VALID_COOKIE = "session=valid"
        private const val PUBLIC_ORIGIN = "http://127.0.0.1:4173"
        private val PATH_VARIABLE = Regex("\\{[^/}]+}")
        private val directory: Path = Files.createTempDirectory("meatbox-path-guard-")
        private val stateDirectory: Path = Files.createDirectory(directory.resolve("state"))
        private val database: Path = directory.resolve("resources.sqlite")
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/session", ::sessionResponse)
            start()
        }

        init {
            createV2Database(database)
            Files.createDirectories(directory.resolve("days"))
            Files.writeString(
                directory.resolve("manifest.json"),
                "{\"schemaVersion\":1,\"defaultDate\":\"$DATE\",\"dates\":[{\"date\":\"$DATE\",\"weekday\":\"월요일\"}]}",
            )
            Files.writeString(directory.resolve("days/$DATE.json"), "{\"date\":\"$DATE\",\"orders\":[]}\n")
            Files.writeString(directory.resolve("regions.geojson"), "{\"type\":\"FeatureCollection\",\"features\":[]}")
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
            registry.add("meatbox.dispatch.enabled") { "true" }
            registry.add("meatbox.dispatch.state-dir") { stateDirectory.toString() }
            registry.add("meatbox.dispatch.public-origin") { PUBLIC_ORIGIN }
        }

        @JvmStatic
        @AfterAll
        fun closeFixtures() {
            sessionServer.stop(0)
            directory.toFile().deleteRecursively()
        }

        private fun sessionResponse(exchange: HttpExchange) {
            val valid = exchange.requestHeaders.getFirst("Cookie") == VALID_COOKIE
            val body = if (valid) {
                "{\"user\":{\"username\":\"fixture-user\"}}"
            } else {
                "{\"error\":\"LOGIN_REQUIRED\"}"
            }.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(if (valid) 200 else 401, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
    }
}
