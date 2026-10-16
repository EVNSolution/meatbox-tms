package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.assertProblem
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
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OpsAlertsHttpTest(
    @param:LocalServerPort private val port: Int,
    @param:Autowired private val alerts: ErrorAlerts,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()

    @Test
    fun `requires a session and lists recent alerts without secrets`() {
        val denied = get(null)
        assertThat(denied.statusCode()).isEqualTo(401)
        assertThat(denied.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
        assertProblem(denied.body(), 401, "LOGIN_REQUIRED")

        alerts.report("server", "OPS_TEST_CODE", "detail-1")
        val ok = get(VALID_COOKIE)
        assertThat(ok.statusCode()).isEqualTo(200)
        val json = JsonMapper.builder().build().readTree(ok.body())
        assertThat(json.path("channel").asString()).isEqualTo("LogAlertChannel")
        val first = json.path("alerts").first()
        assertThat(first.path("subject").asString()).contains("OPS_TEST_CODE")
        assertThat(first.path("at").asString()).isNotBlank()
        assertThat(first.path("suppressedCount").asInt()).isZero()
        assertThat(ok.body()).doesNotContain("detail-1").doesNotContain("http")
    }

    private fun get(cookie: String?): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/ops/alerts"))
        cookie?.let { builder.header("Cookie", it) }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    companion object {
        private const val VALID_COOKIE = "session=valid"
        private val directory = Files.createTempDirectory("meatbox-ops-http-")
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/") { exchange: HttpExchange ->
                val valid = exchange.requestHeaders.getFirst("Cookie") == VALID_COOKIE
                val body = if (valid) {
                    "{\"user\":{\"username\":\"fixture-user\"}}"
                } else {
                    "{\"error\":\"LOGIN_REQUIRED\"}"
                }.toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(if (valid) 200 else 401, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.compat.enabled") { "true" }
            registry.add("meatbox.compat.legacy-api-origin") { "http://127.0.0.1:${sessionServer.address.port}" }
            registry.add("meatbox.compat.dispatch-data-dir") { directory.toString() }
        }

        @JvmStatic
        @AfterAll
        fun close() {
            sessionServer.stop(0)
            directory.toFile().delete()
        }
    }
}
