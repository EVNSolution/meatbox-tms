package com.evnsolution.meatbox.integrations.meatbox.mock

import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.integrations.meatbox.outbound.MeatboxClient
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxSender
import com.evnsolution.meatbox.ops.quietAlerts
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["meatbox.mock-receiver.enabled=true"],
)
class MockMeatboxReceiverTest(@param:LocalServerPort private val port: Int) {
    @TempDir lateinit var directory: Path

    private val client = HttpClient.newHttpClient()

    @Test
    fun `accepts the three contract bodies with 202 and lists them by kind`() {
        val delivery = post("delivery-status", "k-1", DELIVERY)
        assertThat(delivery.statusCode()).isEqualTo(202)
        assertThat(delivery.body()).isEqualTo("""{"accepted":true}""")
        assertThat(post("eta", "k-2", ETA).statusCode()).isEqualTo(202)
        assertThat(post("temperature", "k-3", TEMPERATURE).statusCode()).isEqualTo(202)
        assertThat(received("").map { it.path("idempotencyKey").asString() }).contains("k-1", "k-2", "k-3")
        val deliveries = received("?kind=delivery-status")
        assertThat(deliveries.last().path("idempotencyKey").asString()).isEqualTo("k-1")
        assertThat(deliveries.last().path("body").path("orderId").asString()).isEqualTo("MB-1")
    }

    @Test
    fun `rejects a missing key a missing required field and a wrong value with problem json 400`() {
        val noKey = post("delivery-status", null, DELIVERY)
        assertThat(noKey.statusCode()).isEqualTo(400)
        assertThat(noKey.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
        assertProblem(noKey.body(), 400, "IDEMPOTENCY_KEY_REQUIRED")
        val noOrder = post("delivery-status", "k-1", DELIVERY.replace(""""orderId":"MB-1",""", ""))
        assertProblem(noOrder.body(), 400, "INVALID_BODY")
        val badStatus = post("delivery-status", "k-1", DELIVERY.replace("delivered", "lost"))
        assertProblem(badStatus.body(), 400, "INVALID_BODY")
        assertProblem(post("delivery-status", "other", DELIVERY).body(), 400, "IDEMPOTENCY_KEY_MISMATCH")
        assertProblem(post("eta", "k-2", """{"messageId":"k-2","vehicleId":"V1"}""").body(), 400, "INVALID_BODY")
        assertProblem(post("temperature", "k-3", "[]").body(), 400, "INVALID_BODY")
        assertThat(get("/mock/meatbox/received?kind=other").statusCode()).isEqualTo(400)
    }

    @Test
    fun `keeps a repeated key once and only the latest 200 messages`() {
        repeat(2) {
            assertThat(post("delivery-status", "dup", DELIVERY.replace("k-1", "dup")).statusCode()).isEqualTo(202)
        }
        assertThat(received("").count { it.path("idempotencyKey").asString() == "dup" }).isEqualTo(1)
        repeat(205) { post("temperature", "t-$it", TEMPERATURE.replace("k-3", "t-$it")) }
        val kept = received("")
        assertThat(kept).hasSize(200)
        assertThat(kept.last().path("idempotencyKey").asString()).isEqualTo("t-204")
    }

    @Test
    fun `receives what the dispatcher sends through the real client`() {
        val f = routeFixture(directory)
        val client = MeatboxClient("http://127.0.0.1:$port/mock/meatbox", "t")
        val dispatcher = OutboxSender(f.dispatch, client, quietAlerts(), f.now::get)
        dispatcher.tick()
        val sent = received("?kind=delivery-status")
            .filter { it.path("body").path("messageId").asString().startsWith(DRIVER_DATE) }
        assertThat(sent).hasSize(4)
        assertThat(sent.first().path("idempotencyKey").asString())
            .isEqualTo(sent.first().path("body").path("messageId").asString())
        assertThat(sent.map { it.path("body").path("status").asString() }).containsOnly("dispatched")
    }

    private fun received(query: String) =
        driverJson.readTree(get("/mock/meatbox/received$query").body()).path("messages").toList()

    private fun get(path: String): HttpResponse<String> =
        client.send(
            HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).build(),
            HttpResponse.BodyHandlers.ofString(),
        )

    private fun post(kind: String, key: String?, body: String): HttpResponse<String> {
        val request = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/mock/meatbox/$kind"))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body))
        key?.let { request.header("Idempotency-Key", it) }
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString())
    }

    private companion object {
        const val ETA = """{"messageId":"k-2","vehicleId":"V1","computedAt":"x","reason":"departed","stops":[]}"""
        const val TEMPERATURE = """{"messageId":"k-3","vehicleId":"V1","sensorId":"S","measurements":[]}"""
        const val DELIVERY = """{"messageId":"k-1","orderId":"MB-1","status":"delivered",
            "occurredAt":"2026-11-02T10:41:00+09:00","vehicleId":"V1","photos":[],"note":null,"items":null,"failure":null}"""
    }
}

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MockMeatboxReceiverOffTest(@param:LocalServerPort private val port: Int) {
    @Test
    fun `is not mounted unless the property is set`() {
        val client = HttpClient.newHttpClient()
        for (path in listOf("delivery-status", "eta", "temperature")) {
            val request = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/mock/meatbox/$path"))
                .header("Content-Type", "application/json").header("Idempotency-Key", "k")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build()
            assertThat(client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(404)
        }
        val list = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/mock/meatbox/received")).build()
        assertThat(client.send(list, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(404)
    }
}
