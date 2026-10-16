package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Path

class DriverEventsTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `departs with a new order then completes and fails stops through the operational commands`() {
        val f = routeFixture(directory)
        val departed = f.send("e-depart", "departed", """{"stopOrder":["O4","O3","O1"]}""")
        assertThat(departed.body.path("accepted").asBoolean()).isTrue()
        assertThat(departed.body.path("duplicate").asBoolean()).isFalse()
        assertThat(departed.body.path("next").path("stopId").asString()).isEqualTo("O4")
        assertThat(departed.body.path("next").path("eta").asString()).isNotBlank()
        assertThat(f.order()).containsExactly("O4", "O3", "O1", "O2")
        assertThat(f.phase()).isEqualTo("delivering")

        val photo = f.driver.activity.savePhoto(DRIVER_DATE, DriverLocationPhotoTest.JPEG).path("photoId").asString()
        val before = f.revision()
        val completed = envelope(
            "e-done", "stop_completed",
            """{"stopId":"O4","orderIds":["O4"],"photoIds":["$photo"],"note":"문 앞","scannedCodes":["880"]}""",
        )
        val first = f.driver.activity.acceptEvent(DRIVER_DATE, completed)
        // The stop was never arrived at, so the translation arrives first: two operational steps, one event.
        assertThat(first.body.path("stop").path("status").asString()).isEqualTo("done")
        assertThat(first.body.path("next").path("stopId").asString()).isEqualTo("O3")
        assertThat(f.revision()).isEqualTo(before + 2)
        val second = f.driver.activity.acceptEvent(DRIVER_DATE, completed)
        assertThat(second.duplicate).isTrue()
        assertThat(f.revision()).isEqualTo(before + 2)
        assertThat(second.body.deepCopy().put("duplicate", false)).isEqualTo(first.body)
        assertThat(f.driver.activity.eventResult(DRIVER_DATE, "e-done")).isEqualTo(second.body)

        val failed = f.send("e-fail", "stop_failed", """{"stopId":"O3","reasonCode":"ABSENT","note":"부재"}""")
        assertThat(failed.body.path("stop").path("status").asString()).isEqualTo("skipped")
        assertThat(failed.body.path("next").path("stopId").asString()).isEqualTo("O1")

        val items = """[{"sku":"PK-1","deliveredQty":1,"orderedQty":2}]"""
        val partial = f.send("e-part", "stop_partially_completed", """{"stopId":"O2","items":$items}""")
        assertThat(partial.body.path("stop")).isEqualTo(driverJson.readTree("""{"stopId":"O1","status":"done"}"""))
        assertThat(partial.body.has("next")).isFalse()
        assertThat(f.phase()).isEqualTo("done")
    }

    @Test
    fun `enters a zone without changing state and records the position`() {
        val f = routeFixture(directory)
        val before = f.revision()
        val zone = envelope("e-zone", "zone_entered", """{"zoneId":"Z-07"}""", location = true)
        val reply = f.driver.activity.acceptEvent(DRIVER_DATE, zone)
        assertThat(reply.body.path("accepted").asBoolean()).isTrue()
        assertThat(f.revision()).isEqualTo(before)
        val record = f.stateFile().path("events").first()
        assertThat(record.path("zoneId").asString()).isEqualTo("Z-07")
        assertThat(record.path("location").path("lat").doubleValue()).isEqualTo(37.5)
        val restored = f.restarted().driver.activity.eventResult(DRIVER_DATE, "e-zone")
        assertThat(restored).isEqualTo(reply.body.put("duplicate", true))
    }

    @Test
    fun `reorders before departure and locks the route afterwards`() {
        val f = routeFixture(directory)
        val order = """{"stopOrder":["O3","O1","O4"],"expectedRevision":${f.revision()}}"""
        assertThat(f.send("e-order", "route_reordered", order).body.path("accepted").asBoolean()).isTrue()
        assertThat(f.order()).containsExactly("O3", "O1", "O2", "O4")
        assertCode(409, "REVISION_CONFLICT") {
            f.send("e-stale", "route_reordered", """{"stopOrder":["O1","O3","O4"],"expectedRevision":0}""")
        }
        f.send("e-go", "departed", "{}")
        assertCode(409, "ROUTE_LOCKED") { f.send("e-late", "route_reordered", """{"stopOrder":["O1","O3","O4"]}""") }
    }

    @Test
    fun `answers state reversal with the operational conflict and applies nothing`() {
        val f = routeFixture(directory)
        f.send("e-go", "departed", "{}")
        f.send("e-1", "stop_completed", """{"stopId":"O1"}""")
        val before = f.revision()
        assertCode(409, "OPERATION_REVISION_CONFLICT") { f.send("e-again", "stop_completed", """{"stopId":"O1"}""") }
        assertCode(409, "OPERATION_REVISION_CONFLICT") { f.send("e-redepart", "departed", "{}") }
        assertThat(f.revision()).isEqualTo(before)
        // Nothing was stored for the failed ids, so the same id can be sent again later.
        assertCode(404, "REQUEST_NOT_FOUND") { f.driver.activity.eventResult(DRIVER_DATE, "e-again") }
    }

    @Test
    fun `rejects a reused event id with another body`() {
        val f = routeFixture(directory)
        f.send("e-same", "zone_entered", """{"zoneId":"Z-1"}""")
        assertCode(409, "REQUEST_ID_MISMATCH") { f.send("e-same", "zone_entered", """{"zoneId":"Z-2"}""") }
    }

    @Test
    fun `rejects invalid envelopes payloads codes and unknown photos or stops`() {
        val f = routeFixture(directory)
        val zone = """{"zoneId":"Z"}"""
        assertCode(400, "INVALID_EVENT_TYPE") { f.send("e1", "teleported", "{}") }
        assertCode(400, "INVALID_INPUT") { f.send("e2", "zone_entered", zone) { put("date", "2026-10-14") } }
        assertCode(400, "INVALID_INPUT") { f.send("bad id", "departed", "{}") }
        assertCode(400, "INVALID_INPUT") { f.send("e3", "departed", """{"extra":1}""") }
        assertCode(400, "INVALID_INPUT") { f.send("e4", "zone_entered", zone) { put("occurredAt", "yesterday") } }
        val lazy = """{"stopId":"O1","reasonCode":"LAZY"}"""
        assertCode(400, "INVALID_REASON_CODE") { f.send("e5", "stop_failed", lazy) }
        val unknown = """{"stopId":"O1","photoIds":["00000000-0000-4000-8000-000000000000"]}"""
        assertCode(400, "PHOTO_NOT_FOUND") { f.send("e6", "stop_completed", unknown) }
        assertCode(404, "STOP_NOT_FOUND") { f.send("e7", "stop_completed", """{"stopId":"nope"}""") }
        assertCode(404, "DRIVER_VEHICLE_NOT_FOUND") { f.send("e8", "departed", "{}") { put("vehicleId", "G9") } }
        assertCode(400, "INVALID_INPUT") { f.send("e9", "stop_completed", """{"stopId":"O1","orderIds":["O3"]}""") }
        assertThat(f.state.resolve("driver-$DRIVER_DATE.json").toFile().exists()).isFalse()
    }

    private fun assertCode(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun RouteFixture.send(
        id: String,
        type: String,
        payload: String,
        change: ObjectNode.() -> Unit = {},
    ) = driver.activity.acceptEvent(DRIVER_DATE, envelope(id, type, payload).apply(change))

    private fun RouteFixture.stateFile() = driverJson.readTree(state.resolve("driver-$DRIVER_DATE.json").toFile())

    private fun RouteFixture.snapshot() = dispatch.snapshot(DRIVER_DATE)

    private fun RouteFixture.revision() = snapshot().path("revision").asLong()

    private fun RouteFixture.phase() = snapshot().path("vehicleStates").path("G1").path("phase").asString()

    private fun RouteFixture.order() = snapshot().path("fleetDeliveries").toList().map { it.path("id").asString() }

    private fun envelope(id: String, type: String, payload: String, location: Boolean = false): ObjectNode =
        (driverJson.readTree(
            """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
        ) as ObjectNode).also {
            if (location) it.set("location", driverJson.readTree("""{"lat":37.5,"lng":127.04,"accuracyM":8}"""))
        }
}
