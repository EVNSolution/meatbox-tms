package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.driver.RouteFixture
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.integrations.meatbox.outbound.MeatboxClient
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxSender
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
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

class TemperatureBatcherTest {
    @TempDir lateinit var directory: Path

    private class Hit(val key: String?, val body: JsonNode)

    private val hits = CopyOnWriteArrayList<Hit>()
    private val answers = ArrayDeque<Int>()
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private val alerts = ErrorAlerts(channel, "test", executor)
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/tms/temperature") { exchange ->
            val body = driverJson.readTree(exchange.requestBody.readAllBytes())
            hits += Hit(exchange.requestHeaders.getFirst("Idempotency-Key"), body)
            val status = synchronized(answers) { answers.removeFirstOrNull() } ?: 202
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        // The route fixture's published day owes delivery messages too; these tests watch temperature only.
        for (path in listOf("/tms/delivery-status", "/tms/eta")) {
            createContext(path) { exchange ->
                exchange.requestBody.readAllBytes()
                exchange.sendResponseHeaders(202, -1)
                exchange.close()
            }
        }
        start()
    }

    @AfterEach
    fun stop() = server.stop(0)

    private val fixture: RouteFixture by lazy { routeFixture(directory) }
    private val root: Path by lazy { directory.toRealPath().resolve("telemetry") }
    private val base = Instant.parse("2026-10-13T01:00:00Z")

    private inner class Instance {
        val store = TemperatureStore(root, { Instant.ofEpochMilli(fixture.now.get()) })
        val outbox = TemperatureOutbox(store, root, fixture.now::get)
        val batcher = TemperatureBatcher(outbox, alerts)
        val sender = OutboxSender(
            fixture.dispatch, MeatboxClient("http://127.0.0.1:${server.address.port}", ""), alerts,
            fixture.now::get, telemetryOutbox = outbox,
        )
    }

    private fun Instance.send(sensor: String, secondsBefore: Long, celsius: Double, vehicle: String = "V-1") {
        val at = Instant.ofEpochMilli(fixture.now.get()).minusSeconds(secondsBefore)
        store.ingest(Batch(vehicle, sensor, listOf(Reading(sensor, at, celsius, "frozen"))))
    }

    private fun celsiusOf(hit: Hit) = hit.body.path("measurements").toList().map { it.path("celsius").doubleValue() }

    private fun temperature() = hits.toList()

    @Test
    fun `turns a minute of measurements into one message that is sent with its message id as key`() {
        val one = Instance()
        one.send("S-1", 90, -18.4)
        one.send("S-1", 60, -18.1)
        one.send("S-1", 30, -18.0)
        one.batcher.tick()
        one.sender.tick()

        val hit = temperature().single()
        assertThat(hit.key).isEqualTo("V-1-202610131000-S-1").isEqualTo(hit.body.path("messageId").asString())
        assertThat(hit.body.path("vehicleId").asString()).isEqualTo("V-1")
        assertThat(hit.body.path("sensorId").asString()).isEqualTo("S-1")
        assertThat(celsiusOf(hit)).containsExactly(-18.4, -18.1, -18.0)
        assertThat(hit.body.path("measurements").first().path("measuredAt").asString())
            .isEqualTo("2026-10-13T09:58:30+09:00")
        assertThat(hit.body.path("measurements").first().propertyNames()).containsExactly("measuredAt", "celsius")
        assertThat(one.outbox.summary().path("sent").asInt()).isEqualTo(1)
        one.sender.tick()
        assertThat(temperature()).hasSize(1)
    }

    @Test
    fun `sends only what is new, leaves gaps empty and takes a late old measurement with the next batch`() {
        val one = Instance()
        one.send("S-1", 600, -18.0)
        one.send("S-1", 60, -17.0)
        one.batcher.tick()
        one.sender.tick()

        fixture.now.addAndGet(60_000)
        one.batcher.tick()
        one.sender.tick()
        assertThat(temperature()).hasSize(1)

        one.send("S-1", 300, -16.0)
        one.send("S-1", 10, -15.0)
        fixture.now.addAndGet(60_000)
        one.batcher.tick()
        one.sender.tick()

        assertThat(temperature().map(::celsiusOf)).containsExactly(listOf(-18.0, -17.0), listOf(-16.0, -15.0))
        assertThat(temperature()[0].body.path("measurements").size()).isEqualTo(2)
    }

    @Test
    fun `makes one message per sensor, splits at 500 and keeps ids apart within a minute`() {
        val one = Instance()
        one.send("S-2", 30, 3.0)
        val many = (1..501).map { Reading("S-1", base.minusSeconds(100_000L - it), -18.0, null) }
        one.store.ingest(Batch("V-1", "S-1", many.take(500)))
        one.store.ingest(Batch("V-1", "S-1", many.drop(500)))
        one.send("S-1", 20, -17.0)
        one.batcher.tick()
        one.sender.tick()
        one.sender.tick()
        one.sender.tick()

        val bySensor = temperature().groupBy { it.body.path("sensorId").asString() }
        assertThat(bySensor["S-2"]).hasSize(1)
        assertThat(bySensor.getValue("S-1").map { it.body.path("measurements").size() }).containsExactly(500, 2)
        assertThat(temperature().map { it.key }.toSet()).hasSize(3)
        assertThat(bySensor.getValue("S-1").map { it.key })
            .containsExactly("V-1-202610131000-S-1", "V-1-202610131000-S-1-2")
    }

    @Test
    fun `a second pass in the same minute does not reuse the id of the first`() {
        val one = Instance()
        one.send("S-1", 30, -18.0)
        one.batcher.tick()
        one.send("S-1", 10, -17.0)
        one.batcher.tick()
        repeat(2) { one.sender.tick() }

        assertThat(temperature().map { it.key }).containsExactly("V-1-202610131000-S-1", "V-1-202610131000-S-1-2")
    }

    @Test
    fun `keeps unsent messages and the cursor over a restart and resends nothing that went out`() {
        val before = Instance()
        before.send("S-1", 60, -18.0)
        before.batcher.tick()
        answers += 503
        before.sender.tick()
        before.send("S-1", 30, -17.0)

        val after = Instance()
        fixture.now.addAndGet(60_000)
        after.sender.tick()
        assertThat(after.outbox.summary().path("pending").asInt()).isZero()
        after.batcher.tick()
        after.sender.tick()

        assertThat(temperature().map { it.key }.distinct()).hasSize(2)
        assertThat(temperature().map(::celsiusOf)).containsExactly(listOf(-18.0), listOf(-18.0), listOf(-17.0))
        assertThat(after.outbox.summary().path("pending").asInt()).isZero()
        val repeat = Instance()
        repeat.batcher.tick()
        repeat.sender.tick()
        assertThat(temperature()).hasSize(3)
    }

    @Test
    fun `a later message of a vehicle waits for the unsent one before it`() {
        val one = Instance()
        one.send("S-1", 60, -18.0)
        one.batcher.tick()
        answers += 503
        one.sender.tick()
        one.send("S-1", 30, -17.0)
        fixture.now.addAndGet(1_000)
        one.batcher.tick()
        one.sender.tick()

        assertThat(temperature()).hasSize(1)
        fixture.now.addAndGet(5_000)
        one.sender.tick()
        one.sender.tick()
        assertThat(temperature().map(::celsiusOf)).containsExactly(listOf(-18.0), listOf(-18.0), listOf(-17.0))
    }

    @Test
    fun `a rejected message stops without a retry and alerts once with its own code`() {
        val one = Instance()
        one.send("S-1", 60, -18.0)
        one.batcher.tick()
        answers += 400
        one.sender.tick()
        fixture.now.addAndGet(600_000)
        one.sender.tick()
        executor.drain()

        assertThat(temperature()).hasSize(1)
        assertThat(one.outbox.summary().path("failed").asInt()).isEqualTo(1)
        assertThat(channel.sent.map { it.first }.filter { it.contains("TEMPERATURE_REJECTED") }).hasSize(1)
    }

    @Test
    fun `keeps the cursor file after the first batch and a second pass with nothing new changes nothing`() {
        val one = Instance()
        one.send("S-1", 60, -18.0, vehicle = "V-1")
        one.batcher.tick()
        one.batcher.tick()

        assertThat(Files.exists(root.resolve("V-1/outbox.json"))).isTrue()
        assertThat(Files.readString(root.resolve("V-1/outbox.json"))).contains("\"2026-10-13\"")
        assertThat(one.outbox.summary().path("vehicles").size()).isEqualTo(1)
    }
}
