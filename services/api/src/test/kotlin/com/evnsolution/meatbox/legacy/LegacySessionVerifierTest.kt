package com.evnsolution.meatbox.legacy

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

class LegacySessionVerifierTest {
    private lateinit var server: HttpServer
    private val mode = AtomicReference("valid")
    private val receivedCookie = AtomicReference<String?>()
    private val receivedUpgrade = AtomicReference<String?>()
    private val receivedMethod = AtomicReference<String?>()

    @BeforeEach
    fun startServer() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.executor = Executors.newCachedThreadPool()
        server.createContext("/api/session", ::respond)
        server.createContext("/redirect") { exchange ->
            exchange.responseHeaders.add("Location", "/api/session")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
        }
        server.start()
    }

    @AfterEach
    fun stopServer() {
        server.stop(0)
    }

    @Test
    fun `uses a plain HTTP 1 1 get and forwards the browser cookie`() {
        val username = verifier(http11Client = true).verify("session=valid")

        assertThat(username).isEqualTo("tester")
        assertThat(receivedCookie.get()).isEqualTo("session=valid")
        assertThat(receivedUpgrade.get()).isNull()
        assertThat(receivedMethod.get()).isEqualTo("GET")
    }

    @Test
    fun `keeps a normal legacy 401 distinct from bridge failures`() {
        mode.set("unauthorized")
        assertThatThrownBy { verifier().verify(null) }.isInstanceOf(LoginRequiredException::class.java)

        for (failure in listOf(
            "malformed",
            "oversized",
            "wrong-user",
            "invalid-username",
            "long-username",
            "control-username",
            "wrong-type",
            "redirect",
        )) {
            mode.set(failure)
            assertThatThrownBy { verifier().verify("session=test") }
                .describedAs(failure)
                .isInstanceOf(SessionUnavailableException::class.java)
        }
    }

    @Test
    fun `times out a response whose body never completes`() {
        mode.set("stalled")

        assertThatThrownBy { verifier(Duration.ofMillis(100)).verify("session=test") }
            .isInstanceOf(SessionUnavailableException::class.java)
    }

    private fun verifier(
        timeout: Duration = Duration.ofSeconds(1),
        http11Client: Boolean = false,
    ): LegacySessionVerifier = LegacySessionVerifier(
        HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).apply {
            if (http11Client) version(HttpClient.Version.HTTP_1_1)
        }.build(),
        URI("http://127.0.0.1:${server.address.port}"),
        timeout,
    )

    private fun respond(exchange: HttpExchange) {
        receivedCookie.set(exchange.requestHeaders.getFirst("Cookie"))
        receivedUpgrade.set(exchange.requestHeaders.getFirst("Upgrade"))
        receivedMethod.set(exchange.requestMethod)
        when (mode.get()) {
            "unauthorized" -> send(exchange, 401, "application/json", "{\"error\":\"LOGIN_REQUIRED\"}".toByteArray())
            "malformed" -> send(exchange, 200, "application/json", "{".toByteArray())
            "oversized" -> send(
                exchange,
                200,
                "application/json",
                ByteArray(LegacySessionVerifier.MAX_BODY_BYTES + 1) { 'x'.code.toByte() },
            )
            "wrong-user" -> send(exchange, 200, "application/json", "{\"user\":{\"userId\":\"wrong\"}}".toByteArray())
            "invalid-username" -> session(exchange, "bad user")
            "long-username" -> session(exchange, "a".repeat(41))
            "control-username" -> session(exchange, "bad\\nuser")
            "wrong-type" -> send(exchange, 200, "text/plain", "{\"user\":{\"username\":\"test\"}}".toByteArray())
            "redirect" -> {
                exchange.responseHeaders.add("Location", "/redirect")
                exchange.sendResponseHeaders(302, -1)
                exchange.close()
            }
            "stalled" -> {
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write("{\"user\":".toByteArray())
                exchange.responseBody.flush()
                Thread.sleep(1_000)
                exchange.close()
            }
            else -> send(
                exchange,
                200,
                "application/json; charset=utf-8",
                "{\"user\":{\"username\":\"tester\"}}".toByteArray(),
            )
        }
    }

    private fun send(exchange: HttpExchange, status: Int, contentType: String, body: ByteArray) {
        exchange.responseHeaders.add("Content-Type", contentType)
        exchange.sendResponseHeaders(status, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }

    private fun session(exchange: HttpExchange, username: String) {
        send(exchange, 200, "application/json", "{\"user\":{\"username\":\"$username\"}}".toByteArray())
    }
}
