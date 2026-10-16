package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.RouteChange
import com.evnsolution.meatbox.dispatch.RouteChangeListener
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Path

/** The answer to an operator's command says which drivers were told, so that the web can show it. */
class DriverNoticeTest {
    @TempDir lateinit var directory: Path

    private fun listener(configured: Boolean) = object : RouteChangeListener {
        override fun changed(date: String, revision: Long, changes: List<RouteChange>) = Unit
        override val pushConfigured: Boolean = configured
    }

    private fun reorder(f: RouteFixture): ObjectNode {
        val deliveries = f.dispatch.snapshot(DRIVER_DATE).path("fleetDeliveries").toList()
            .filter { it.path("vehicleId").asString() == "G1" }
        val ids = deliveries.map { it.path("id").asString() }
        val command = driverJson.createObjectNode().put("expectedBoot", f.dispatch.boot)
            .put("expectedRevision", f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong())
            .put("type", "set_route_order").put("vehicleId", "G1").put("expectedPhase", "idle")
        command.putArray("order").apply { listOf(ids[2], ids[3], ids[0], ids[1]).forEach(::add) }
        command.putArray("expectedOrder").apply { ids.forEach(::add) }
        command.putArray("expectedStatuses").apply { deliveries.forEach { add(it.path("status").asString()) } }
        return f.dispatch.command(DRIVER_DATE, command)
    }

    @Test
    fun `a command that moves a route answers with the vehicle told and a queued push`() {
        val f = routeFixture(directory) { it.dispatch.routeChanges = listener(configured = true) }
        val notice = reorder(f).path("driverNotice")
        assertThat(notice.path("vehicles").asInt()).isEqualTo(1)
        assertThat(notice.path("push").asString()).isEqualTo("queued")
        assertThat(notice.path("changes").first().path("vehicleId").asString()).isEqualTo("G1")
        assertThat(notice.path("changes").first().path("text").asString()).isEqualTo("배차가 변경되었습니다. 순서 변경")
    }

    @Test
    fun `without a push account the answer says so instead of claiming a send`() {
        val f = routeFixture(directory) { it.dispatch.routeChanges = listener(configured = false) }
        assertThat(reorder(f).path("driverNotice").path("push").asString()).isEqualTo("unconfigured")
    }

    @Test
    fun `an answer without a changed route, or without a listener, carries no notice`() {
        val none = routeFixture(directory.resolve("none").also { java.nio.file.Files.createDirectory(it) })
        assertThat(reorder(none).has("driverNotice")).isFalse()
        val f = routeFixture(directory) { it.dispatch.routeChanges = listener(configured = true) }
        val state = f.dispatch.snapshot(DRIVER_DATE)
        val same = driverJson.createObjectNode().put("expectedBoot", f.dispatch.boot)
            .put("expectedRevision", state.path("revision").asLong()).put("type", "start_route")
            .put("vehicleId", "G1")
        assertThat(f.dispatch.command(DRIVER_DATE, same).has("driverNotice")).isFalse()
    }
}
