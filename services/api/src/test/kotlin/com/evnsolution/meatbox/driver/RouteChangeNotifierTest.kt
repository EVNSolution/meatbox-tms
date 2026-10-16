package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.RouteChange
import com.evnsolution.meatbox.dispatch.RouteChangeListener
import com.evnsolution.meatbox.integrations.fcm.PushContent
import com.evnsolution.meatbox.integrations.fcm.PushSummary
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Path

class RouteChangeNotifierTest {
    @TempDir lateinit var directory: Path

    private class Seen {
        val changes = mutableListOf<Pair<Long, List<RouteChange>>>()
        val pushes = mutableListOf<Triple<List<String>, String, PushContent>>()
    }

    private fun fixture(seen: Seen, withNotifier: Boolean = true): RouteFixture = routeFixture(directory) { f ->
        if (withNotifier) {
            val notifier = RouteChangeNotifier(f.driver, { tokens, date, vehicleId, content ->
                seen.pushes += Triple(tokens, "$date/$vehicleId", content)
                PushSummary("sent", tokens.size, tokens.size, 0)
            }, { it.run() })
            f.dispatch.routeChanges = RouteChangeListener { _, revision, changes ->
                seen.changes += revision to changes
                notifier.changed(DRIVER_DATE, revision, changes)
            }
        }
    }

    private fun RouteFixture.register(vehicleId: String, token: String) =
        driver.register(DRIVER_DATE, "user-$vehicleId", DRIVER_DIGEST, vehicleId, token, "device-$token")

    private fun RouteFixture.command(build: ObjectNode.() -> Unit) {
        val snapshot = dispatch.snapshot(DRIVER_DATE)
        val command = driverJson.createObjectNode().put("expectedBoot", dispatch.boot)
            .put("expectedRevision", snapshot.path("revision").asLong())
        command.build()
        dispatch.command(DRIVER_DATE, command)
    }

    private fun envelope(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:00:00+09:00","date":"$DRIVER_DATE",
        "vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode

    @Test
    fun `confirming the day tells the vehicle that got orders, with its tokens only`() {
        val seen = Seen()
        val f = fixture(seen)
        assertThat(seen.changes).hasSize(1)
        val (revision, changes) = seen.changes.single()
        assertThat(changes).containsExactly(RouteChange("G1", added = 4, removed = 0, reordered = false))
        // No device was registered when the day was published, so the push had no token.
        assertThat(seen.pushes.single().first).isEmpty()
        assertThat(seen.pushes.single().third).isEqualTo(
            PushContent("route_changed", "미트박스 배송", "배차가 변경되었습니다. 주문 추가 4건", "route-$revision"),
        )
        assertThat(f.driver.tokens(DRIVER_DATE, "G1")).isEmpty()
    }

    @Test
    fun `a later operator reorder pushes to the registered devices of that vehicle only`() {
        val seen = Seen()
        val f = fixture(seen)
        f.register("G1", "token-g1")
        f.register("G2", "token-g2")
        seen.pushes.clear(); seen.changes.clear()
        val deliveries = f.dispatch.snapshot(DRIVER_DATE).path("fleetDeliveries").toList()
            .filter { it.path("vehicleId").asString() == "G1" }
        val ids = deliveries.map { it.path("id").asString() }
        val reordered = listOf(ids[2], ids[3], ids[0], ids[1])
        f.command {
            put("type", "set_route_order").put("vehicleId", "G1")
            putArray("order").apply { reordered.forEach(::add) }
            putArray("expectedOrder").apply { ids.forEach(::add) }
            putArray("expectedStatuses").apply { deliveries.forEach { add(it.path("status").asString()) } }
            put("expectedPhase", "idle")
        }
        assertThat(seen.changes.single().second).containsExactly(RouteChange("G1", 0, 0, true))
        assertThat(seen.pushes).hasSize(1)
        assertThat(seen.pushes.single().first).containsExactly("token-g1")
        assertThat(seen.pushes.single().second).isEqualTo("$DRIVER_DATE/G1")
        assertThat(seen.pushes.single().third.body).isEqualTo("배차가 변경되었습니다. 순서 변경")
    }

    @Test
    fun `the driver's own events and plain progress commands send nothing`() {
        val seen = Seen()
        val f = fixture(seen)
        f.register("G1", "token-g1")
        seen.pushes.clear(); seen.changes.clear()
        f.driver.activity.acceptEvent(DRIVER_DATE, envelope("go", "departed", "{}"))
        val revision = f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()
        f.driver.activity.acceptEvent(DRIVER_DATE, envelope("re", "route_reordered",
            """{"stopOrder":["O1","O4","O3"],"expectedRevision":$revision}"""))
        f.command { put("type", "arrive_stop").put("vehicleId", "G1").put("orderId", "O1") }
        assertThat(seen.changes).isEmpty()
        assertThat(seen.pushes).isEmpty()
    }

    @Test
    fun `a failing notification never fails the operator command`() {
        val f = routeFixture(directory) { fixture ->
            fixture.dispatch.routeChanges = RouteChangeListener { _, _, _ -> error("push down") }
        }
        assertThat(f.dispatch.snapshot(DRIVER_DATE).path("dispatch").path("phase").asString()).isEqualTo("published")
    }

    @Test
    fun `tokens come only from devices with an active session`() {
        val f = routeFixture(directory)
        f.register("G1", "alive")
        assertThat(f.driver.tokens(DRIVER_DATE, "G1")).containsExactly("alive")
        assertThat(f.driver.tokens(DRIVER_DATE, "G9")).isEmpty()
        assertThat(f.driver.tokens("2026-01-01", "G1")).isEmpty()
    }
}
