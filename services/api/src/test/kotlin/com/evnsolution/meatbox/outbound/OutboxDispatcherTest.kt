package com.evnsolution.meatbox.outbound

import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.RouteFixture
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.ops.RecordingChannel
import com.evnsolution.meatbox.ops.alertExecutor
import com.evnsolution.meatbox.ops.drain
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

class OutboxDispatcherTest {
    @TempDir lateinit var directory: Path

    private class Hit(val key: String?, val auth: String?, val type: String?, val body: JsonNode)

    private val hits = CopyOnWriteArrayList<Hit>()
    private val answers = ArrayDeque<Int>()
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val alerts = ErrorAlerts(channel, "test", executor)
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/tms/delivery-status") { exchange ->
            val body = driverJson.readTree(exchange.requestBody.readAllBytes())
            val headers = exchange.requestHeaders
            hits += Hit(
                headers.getFirst("Idempotency-Key"), headers.getFirst("Authorization"),
                headers.getFirst("Content-Type"), body,
            )
            val status = synchronized(answers) { answers.removeFirstOrNull() } ?: 202
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        start()
    }

    @AfterEach
    fun stop() = server.stop(0)

    private fun url() = "http://127.0.0.1:${server.address.port}"

    private fun dispatcher(f: RouteFixture, base: String = url(), token: String = "secret-token") =
        OutboxDispatcher(f.dispatch, MeatboxClient(base, token), alerts, f.now::get)

    /** A fixture whose publish and departure messages are already sent, so the next event owes exactly one. */
    private fun ready(): RouteFixture {
        val f = routeFixture(directory)
        f.driver.activity.acceptEvent(DRIVER_DATE, event("e-depart", "departed", """{"stopOrder":["O4","O3","O1"]}"""))
        // A later message of an order waits for its earlier one, so the two rounds go out in two passes.
        repeat(2) { dispatcher(f).tick() }
        assertThat(f.dispatch.outboxSummary(DRIVER_DATE, 20).path("pending").asInt()).isZero()
        hits.clear()
        f.driver.activity.acceptEvent(DRIVER_DATE, event("e-done", "stop_completed", """{"stopId":"O4"}"""))
        return f
    }

    @Test
    fun `sends a due message with its key and token and records sentAt`() {
        val f = ready()
        dispatcher(f).tick()

        val hit = hits.single()
        assertThat(hit.key).isEqualTo("$DRIVER_DATE-6-O4").isEqualTo(hit.body.path("messageId").asString())
        assertThat(hit.auth).isEqualTo("Bearer secret-token")
        assertThat(hit.type).isEqualTo("application/json")
        assertThat(hit.body.path("status").asString()).isEqualTo("delivered")
        val summary = f.dispatch.outboxSummary(DRIVER_DATE, 20)
        assertThat(summary.path("pending").asInt()).isZero()
        assertThat(summary.path("recent").first().path("lastStatus").asString()).isEqualTo("202")
        assertThat(summary.path("recent").first().path("sentAt").asString()).isNotBlank()
        assertThat(summary.toString()).doesNotContain("secret-token")
        dispatcher(f).tick()
        assertThat(hits).hasSize(1)
    }

    @Test
    fun `leaves out the Authorization header when no token is set`() {
        val f = ready()
        dispatcher(f, token = "").tick()
        assertThat(hits.single().auth).isNull()
    }

    @Test
    fun `retries a 503 at 5 then 15 seconds and counts three attempts`() {
        val f = ready()
        answers += listOf(503, 503)
        val dispatcher = dispatcher(f)
        val start = f.now.get()

        dispatcher.tick()
        assertThat(entry(f).path("nextAttemptAt").asLong()).isEqualTo(start + 5_000)
        f.now.set(start + 4_999)
        dispatcher.tick()
        assertThat(hits).hasSize(1)

        f.now.set(start + 5_000)
        dispatcher.tick()
        assertThat(entry(f).path("nextAttemptAt").asLong()).isEqualTo(start + 5_000 + 15_000)
        f.now.set(start + 20_000)
        dispatcher.tick()
        assertThat(hits).hasSize(3)
        assertThat(hits.map { it.key }.toSet()).hasSize(1)
        assertThat(entry(f).path("attempts").asInt()).isEqualTo(3)
        assertThat(entry(f).path("sentAt").asLong()).isEqualTo(start + 20_000)
        executor.drain()
        assertThat(channel.sent).isEmpty()
    }

    @Test
    fun `backs off 5 15 45 seconds 2 minutes and then every 5 minutes`() {
        assertThat((1..7).map { OutboxDispatcher.backoff(it) / 1000 }).containsExactly(5, 15, 45, 120, 300, 300, 300)
    }

    @Test
    fun `does not retry a 400 and raises one rejected alert`() {
        val f = ready()
        answers += 400
        val dispatcher = dispatcher(f)
        dispatcher.tick()
        f.now.addAndGet(3_600_000)
        dispatcher.tick()

        assertThat(hits).hasSize(1)
        assertThat(entry(f).path("failedAt").isIntegralNumber).isTrue()
        assertThat(entry(f).path("lastStatus").asString()).isEqualTo("400")
        executor.drain()
        assertThat(channel.sent).hasSize(1)
        assertThat(channel.sent.single().first).contains("meatbox-outbound", "DELIVERY_STATUS_REJECTED")
        assertThat(channel.sent.single().second).doesNotContain("secret-token")
        assertThat(f.dispatch.outboxSummary(DRIVER_DATE, 20).path("failed").asInt()).isEqualTo(1)
    }

    @Test
    fun `raises one unreachable alert after more than 10 refused connections`() {
        val f = ready()
        val closed = ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val dispatcher = dispatcher(f, base = "http://127.0.0.1:$closed")

        repeat(10) { tickLater(f, dispatcher) }
        executor.drain()
        assertThat(channel.sent).isEmpty()
        tickLater(f, dispatcher)
        tickLater(f, dispatcher)
        executor.drain()
        assertThat(channel.sent).hasSize(1)
        assertThat(channel.sent.single().first).contains("DELIVERY_STATUS_UNREACHABLE")
        assertThat(entry(f).path("attempts").asInt()).isEqualTo(12)
        assertThat(entry(f).path("lastStatus").asString()).isEqualTo("connect-failed")
        assertThat(entry(f).path("sentAt").isNull).isTrue()
    }

    @Test
    fun `a restarted instance sends what was left and never what was sent`() {
        val f = ready()
        answers += 503
        dispatcher(f).tick()
        assertThat(hits).hasSize(1)

        val restarted = f.restarted()
        f.now.addAndGet(5_000)
        dispatcher(restarted).tick()
        assertThat(hits).hasSize(2)
        assertThat(hits[1].key).isEqualTo(hits[0].key)

        val again = restarted.restarted()
        f.now.addAndGet(600_000)
        dispatcher(again).tick()
        assertThat(hits).hasSize(2)
        assertThat(again.dispatch.outboxSummary(DRIVER_DATE, 20).path("sent").asInt()).isEqualTo(9)
    }

    @Test
    fun `an old process with a stale cache does not write over a newer checkpoint`() {
        val f = ready()
        val newer = f.restarted()
        val failure = event("e-fail", "stop_failed", """{"stopId":"O3","reasonCode":"ABSENT"}""")
        newer.driver.activity.acceptEvent(DRIVER_DATE, failure)
        val revision = driverJson.readTree(f.state.resolve("$DRIVER_DATE.json").toFile()).path("revision").asLong()

        dispatcher(f).tick()
        assertThat(hits).hasSize(1)
        val saved = driverJson.readTree(f.state.resolve("$DRIVER_DATE.json").toFile())
        assertThat(saved.path("revision").asLong()).isEqualTo(revision)
        assertThat(saved.path("outbox").toList().map { it.path("body").path("status").asString() }).contains("failed")

        // The stale process reloaded, so its next pass sees the newer messages and sends them.
        dispatcher(f).tick()
        assertThat(f.dispatch.outboxSummary(DRIVER_DATE, 20).path("pending").asInt()).isZero()
    }

    @Test
    fun `keeps messages without sending when no base URL is set`() {
        val f = ready()
        val dispatcher = dispatcher(f, base = "")
        dispatcher.start(1)
        Thread.sleep(1500)
        dispatcher.close()
        assertThat(hits).isEmpty()
        assertThat(f.dispatch.outboxSummary(DRIVER_DATE, 20).path("pending").asInt()).isEqualTo(1)
    }

    private fun tickLater(f: RouteFixture, dispatcher: OutboxDispatcher) {
        f.now.addAndGet(300_000)
        dispatcher.tick()
    }

    private fun entry(f: RouteFixture): JsonNode =
        driverJson.readTree(f.state.resolve("$DRIVER_DATE.json").toFile()).path("outbox").toList()
            .single { it.path("body").path("status").asString() == "delivered" }

    private fun event(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
        "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode
}
