package com.evnsolution.meatbox.integrations.webhook

import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

class WebhookAlertChannelTest {
    private val received = AtomicReference<String>()
    private val contentType = AtomicReference<String>()
    private var status = 200
    private var delayMillis = 0L
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/hook") { exchange ->
            received.set(exchange.requestBody.readAllBytes().toString(Charsets.UTF_8))
            contentType.set(exchange.requestHeaders.getFirst("Content-Type"))
            Thread.sleep(delayMillis)
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        start()
    }
    private val url = "http://127.0.0.1:${server.address.port}/hook"

    @AfterEach fun stop() = server.stop(0)

    @Test
    fun `posts subject body and time as JSON`() {
        val channel = WebhookAlertChannel(url, now = { Instant.parse("2026-01-01T00:00:00Z") })
        channel.send("subject-1", "kind=server\ncode=X")
        val json = JsonMapper.builder().build().readTree(received.get())
        assertThat(contentType.get()).startsWith("application/json")
        assertThat(json.path("subject").asString()).isEqualTo("subject-1")
        assertThat(json.path("body").asString()).isEqualTo("kind=server\ncode=X")
        assertThat(json.path("at").asString()).isEqualTo("2026-01-01T00:00:00Z")
        assertThat(json.path("text").asString()).isEqualTo("subject-1\nkind=server\ncode=X")
    }

    @Test
    fun `fails on non-2xx and on timeout so the caller can log it`() {
        status = 500
        assertThatThrownBy { WebhookAlertChannel(url).send("s", "b") }.hasMessageContaining("500")
        status = 200
        delayMillis = 600
        assertThatThrownBy { WebhookAlertChannel(url, Duration.ofMillis(100)).send("s", "b") }
    }

    @Test
    fun `rejects a non-http URL`() {
        assertThatThrownBy { WebhookAlertChannel("file:///etc/passwd") }
    }
}
