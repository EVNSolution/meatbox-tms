package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path

class OutboxMessagesTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `publishing leaves one dispatched message per order in the same checkpoint`() {
        val f = routeFixture(directory)
        val outbox = f.outbox()
        assertThat(outbox.map { it.path("body").path("status").asString() }).containsOnly("dispatched")
        assertThat(outbox.map { it.path("orderId").asString() }).containsExactlyInAnyOrder("O1", "O2", "O3", "O4")
        assertThat(outbox.map { it.path("messageId").asString() })
            .containsExactlyInAnyOrder(*listOf("O1", "O2", "O3", "O4").map { "$DRIVER_DATE-2-$it" }.toTypedArray())
        val body = outbox.first().path("body")
        assertThat(body.path("vehicleId").asString()).isEqualTo("G1")
        assertThat(body.path("messageId").asString()).isEqualTo(outbox.first().path("messageId").asString())
        assertThat(outbox.first().path("sentAt").isNull).isTrue()
        assertThat(outbox.first().path("attempts").asInt()).isZero()
        // A restart reads the same messages back and does not add any.
        assertThat(f.restarted().dispatch.outboxSummary(DRIVER_DATE, 20).path("pending").asInt()).isEqualTo(4)
    }

    @Test
    fun `each driver event owes one message per order with the mapped status and a resend adds none`() {
        val f = routeFixture(directory)
        f.send("e-depart", "departed", """{"stopOrder":["O4","O3","O1"]}""")
        assertThat(f.since("departed")).extracting<String> { it.path("orderId").asString() }
            .containsExactlyInAnyOrder("O1", "O2", "O3", "O4")

        val photo = f.driver.activity.savePhoto(DRIVER_DATE, DriverLocationPhotoTest.JPEG).path("photoId").asString()
        val done = envelope("e-done", "stop_completed", """{"stopId":"O4","photoIds":["$photo"],"note":"문 앞"}""")
        f.driver.activity.acceptEvent(DRIVER_DATE, done)
        val count = f.outbox().size
        f.driver.activity.acceptEvent(DRIVER_DATE, done)
        assertThat(f.outbox()).hasSize(count)
        val delivered = f.since("delivered").single().path("body")
        assertThat(delivered.path("orderId").asString()).isEqualTo("O4")
        assertThat(delivered.path("occurredAt").asString()).isEqualTo("2026-10-13T10:41:00+09:00")
        assertThat(delivered.path("note").asString()).isEqualTo("문 앞")
        assertThat(delivered.path("photos").toList().map { it.asString() })
            .containsExactly("/api/dispatch-data/days/$DRIVER_DATE/driver/photos/$photo")
        assertThat(delivered.path("failure").isNull).isTrue()

        f.send("e-fail", "stop_failed", """{"stopId":"O3","reasonCode":"ABSENT","note":"부재"}""")
        val failed = f.since("failed").single().path("body")
        assertThat(failed.path("orderId").asString()).isEqualTo("O3")
        assertThat(failed.path("failure")).isEqualTo(driverJson.readTree("""{"reasonCode":"ABSENT","note":"부재"}"""))

        val items = """[{"sku":"PK-1","deliveredQty":1,"orderedQty":2}]"""
        f.send("e-part", "stop_partially_completed", """{"stopId":"O2","orderId":"O2","items":$items}""")
        val partial = f.since("partially_delivered").single().path("body")
        assertThat(partial.path("orderId").asString()).isEqualTo("O2")
        assertThat(partial.path("items")).isEqualTo(driverJson.readTree(items))

        // The bundle O1+O2 closed as a whole, but the partial event names one order, so only O2 is told.
        assertThat(f.since("delivered")).hasSize(1)
        val zone = envelope("e-zone", "zone_entered", """{"zoneId":"Z-1"}""")
        zone.set("location", driverJson.readTree("""{"lat":37.5,"lng":127.0}"""))
        f.driver.activity.acceptEvent(DRIVER_DATE, zone)
        assertThat(f.outbox().map { it.path("messageId").asString() }.toSet()).hasSameSizeAs(f.outbox())
    }

    @Test
    fun `a failed checkpoint write leaves neither the message nor the state change`() {
        val f = routeFixture(directory)
        f.send("e-depart", "departed", "{}")
        val revision = f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()
        val pending = f.outbox().size
        val target = f.state.resolve("$DRIVER_DATE.json")
        val saved = Files.readAllBytes(target)
        Files.delete(target)
        Files.createDirectory(target)

        assertThatThrownBy { f.send("e-done", "stop_completed", """{"stopId":"O1"}""") }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DISPATCH_STATE_WRITE_FAILED")
            }
        assertThat(f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()).isEqualTo(revision)
        assertThat(f.dispatch.outboxSummary(DRIVER_DATE, 20).path("pending").asInt()).isEqualTo(pending)
        Files.delete(target)
        Files.write(target, saved)
        assertThat(String(Files.readAllBytes(target))).doesNotContain("e-done")
    }

    private fun RouteFixture.outbox(): List<JsonNode> =
        driverJson.readTree(state.resolve("$DRIVER_DATE.json").toFile()).path("outbox").toList()

    private fun RouteFixture.since(status: String) =
        outbox().filter { it.path("body").path("status").asString() == status }

    private fun RouteFixture.send(id: String, type: String, payload: String) =
        driver.activity.acceptEvent(DRIVER_DATE, envelope(id, type, payload))

    private fun envelope(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
        "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode
}
