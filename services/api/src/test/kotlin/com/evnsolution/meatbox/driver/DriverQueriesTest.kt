package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path

class DriverQueriesTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `lists the route with status revision phase and a null eta`() {
        val f = routeFixture(directory)
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        val revision = f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()
        assertThat(route.path("revision").asLong()).isEqualTo(revision)
        assertThat(route.path("phase").asString()).isEqualTo("idle")
        assertThat(route.path("stops").toList().map { it.path("stopId").asString() }).containsExactly("O1", "O3", "O4")
        val first = route.path("stops").first()
        assertThat(first.path("orderIds").toList().map { it.asString() }).containsExactly("O1", "O2")
        assertThat(first.path("boxes").asInt()).isEqualTo(2)
        assertThat(first.path("eta").isNull).isTrue()
        assertThat(route.path("next").path("stopId").asString()).isEqualTo("O1")
        f.send("go", "departed", "{}")
        val departed = f.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(departed.path("phase").asString()).isEqualTo("delivering")
        assertThat(departed.path("stops").first().path("status").asString()).isEqualTo("current")
        assertCode(404, "DRIVER_VEHICLE_NOT_FOUND") { f.driver.queries.route(DRIVER_DATE, "G9") }
        assertThat(f.driver.queries.route(DRIVER_DATE, "G2").path("stops").size()).isZero()
    }

    @Test
    fun `shows a stop with its orders and the last completion photo of the same destination`() {
        val f = routeFixture(directory)
        val detail = f.driver.queries.stop(DRIVER_DATE, "G1", "O2")
        assertThat(detail.path("stopId").asString()).isEqualTo("O1")
        assertThat(detail.path("orders").toList().map { it.path("orderId").asString() }).containsExactly("O1", "O2")
        assertThat(detail.path("orders").first().path("name").asString()).isEqualTo("가게A")
        assertThat(detail.path("orders").first().has("access")).isTrue()
        assertThat(detail.path("previousPhoto").isNull).isTrue()

        val unit = f.driver.queries.stop(DRIVER_DATE, "G1", "O3").path("assignmentUnitId").asString()
        val photo = "11111111-1111-4111-8111-111111111111"
        Files.writeString(f.state.resolve("driver-2026-10-12.json"), """
            {"schemaVersion":2,"date":"2026-10-12","devices":[],"messages":[],"events":[
              {"eventId":"old","type":"stop_completed","vehicleId":"G1","assignmentUnitId":"$unit",
               "photoIds":["$photo"],"occurredAt":"2026-10-12T10:00:00+09:00"}]}
        """.trimIndent())
        val previous = f.driver.queries.stop(DRIVER_DATE, "G1", "O3").path("previousPhoto")
        assertThat(previous.path("photoId").asString()).isEqualTo(photo)
        assertThat(previous.path("date").asString()).isEqualTo("2026-10-12")
        assertThat(f.driver.queries.stop(DRIVER_DATE, "G1", "O4").path("previousPhoto").isNull).isTrue()
    }

    @Test
    fun `answers 404 for a stop that is not on this vehicle`() {
        val f = routeFixture(directory)
        assertCode(404, "STOP_NOT_FOUND") { f.driver.queries.stop(DRIVER_DATE, "G2", "O1") }
        assertCode(404, "STOP_NOT_FOUND") { f.driver.queries.stop(DRIVER_DATE, "G1", "nope") }
    }

    @Test
    fun `lists completed and undelivered stops by completion time with their reasons`() {
        val f = routeFixture(directory)
        assertThat(f.driver.queries.history(DRIVER_DATE, "G1").path("items").size()).isZero()
        f.send("go", "departed", "{}")
        f.now.addAndGet(60_000)
        f.send("late", "stop_failed", """{"stopId":"O1","reasonCode":"ABSENT","note":"부재"}""")
        f.now.addAndGet(60_000)
        f.send("done", "stop_completed", """{"stopId":"O3","note":"문 앞"}""")
        val items = f.driver.queries.history(DRIVER_DATE, "G1").path("items").toList()
        assertThat(items.map { it.path("stopId").asString() }).containsExactly("O1", "O3")
        assertThat(items.map { it.path("result").asString() }).containsExactly("failed", "completed")
        assertThat(items.first().path("reasonCode").asString()).isEqualTo("ABSENT")
        assertThat(items.last().path("note").asString()).isEqualTo("문 앞")
        assertThat(items.map { it.path("completedAt").asString() }).isSorted().doesNotHaveDuplicates()
        assertThat(f.driver.queries.history(DRIVER_DATE, "G2").path("items").size()).isZero()
    }

    @Test
    fun `lists only the stops that carry a driver note, newest first, for the operator`() {
        val f = routeFixture(directory)
        assertThat(f.driver.queries.notes(DRIVER_DATE).path("items").size()).isZero()
        f.send("go", "departed", "{}")
        f.now.addAndGet(60_000)
        f.send("late", "stop_failed", """{"stopId":"O1","reasonCode":"ABSENT","note":"부재"}""")
        f.now.addAndGet(60_000)
        f.send("quiet", "stop_completed", """{"stopId":"O3"}""")
        f.now.addAndGet(60_000)
        f.send("done", "stop_completed", """{"stopId":"O4","note":"문 앞"}""")
        val items = f.driver.queries.notes(DRIVER_DATE).path("items").toList()
        assertThat(items.map { it.path("stopId").asString() }).containsExactly("O4", "O1")
        assertThat(items.map { it.path("result").asString() }).containsExactly("completed", "failed")
        assertThat(items.last().path("reasonCode").asString()).isEqualTo("ABSENT")
        assertThat(items.first().path("name").asString()).isNotBlank()
        assertThat(items.first().path("vehicleId").asString()).isEqualTo("G1")
    }

    private fun assertCode(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun RouteFixture.send(id: String, type: String, payload: String) = driver.activity.acceptEvent(
        DRIVER_DATE,
        driverJson.readTree(
            """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:41:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
        ) as ObjectNode,
    )
}
