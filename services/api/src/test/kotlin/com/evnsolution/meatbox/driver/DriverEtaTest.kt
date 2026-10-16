package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.atomic.AtomicLong

class DriverEtaTest {
    @TempDir lateinit var directory: Path

    // Server clock is 10:00 KST. Stops: A (127.05), B (127.10), C (no coordinates), D (127.15), all on 37.5 N.
    private fun fixture(config: EtaConfig = EtaConfig(), name: String = "base"): RouteFixture {
        val root = Files.createDirectories(directory.resolve(name)).toRealPath()
        Files.createDirectories(root.resolve("data/days"))
        Files.createDirectories(root.resolve("state"))
        Files.writeString(root.resolve("data/manifest.json"), """
            {"schemaVersion":1,"defaultDate":"$DRIVER_DATE","dates":[{"date":"$DRIVER_DATE"}],
             "source":{"csvSha256":"fixture"}}
        """.trimIndent())
        fun order(id: String, name: String, sequence: Int, lng: Double?) = """{"id":"$id","groupId":"G1","name":"$name",
            "address":"$name 주소","boxes":1,"sourceRows":1,"sequence":$sequence,"zoneIds":["Z$sequence"]
            ${lng?.let { ""","coordinates":[$it,37.5]""" } ?: ""}}"""
        Files.writeString(root.resolve("data/days/$DRIVER_DATE.json"), """
            {"schemaVersion":1,"date":"$DRIVER_DATE","summary":{"orders":4,"boxes":4},
             "groups":[{"id":"G1","label":"합성 기사","regionNames":["합성 권역"]}],
             "orders":[${order("A", "가게A", 1, 127.05)},${order("B", "가게B", 2, 127.10)},
                       ${order("C", "가게C", 3, null)},${order("D", "가게D", 4, 127.15)}]}
        """.trimIndent())
        val f = open(root, AtomicLong(Instant.parse("${DRIVER_DATE}T01:00:00Z").toEpochMilli()), config)
        fun run(command: ObjectNode) = f.dispatch.command(DRIVER_DATE, command.put("expectedBoot", f.dispatch.boot))
        run(driverJson.createObjectNode().put("type", "calculate_dispatch").put("expectedRevision", 0)
            .set("vehicleIds", driverJson.createArrayNode().add("G1")))
        run(
            driverJson.createObjectNode().put("type", "publish_dispatch").put("expectedRevision", 1)
                .put("draftVersion", 1),
        )
        return f
    }

    private fun open(root: Path, now: AtomicLong, config: EtaConfig = EtaConfig()): RouteFixture {
        val reader = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), root.resolve("data")))
        val dispatch = DispatchStore(reader, root.resolve("state"), now::get)
        val driver = DriverStore(
            dispatch, root.resolve("state"), { Instant.ofEpochMilli(now.get()) }, { _, _ -> true }, etaConfig = config,
        )
        return RouteFixture(driver, dispatch, root.resolve("state"), now)
    }

    @Test
    fun `a departure fills the route eta in order and marks the stop without coordinates as not estimated`() {
        val f = fixture()
        val before = f.driver.queries.route(DRIVER_DATE, "G1").path("stops")
        assertThat(before.toList().map { it.path("eta").isNull }).containsOnly(true)

        val reply = f.send("e-depart", "departed", "{}", location = true)
        val stops = f.driver.queries.route(DRIVER_DATE, "G1").path("stops").toList()
        val etas = stops.toList().map { OffsetDateTime.parse(it.path("eta").asString()).toInstant() }
        assertThat(etas).isSorted().doesNotHaveDuplicates()
        assertThat(stops.toList().map { it.path("estimated").asBoolean() }).containsExactly(true, true, false, true)
        // The stop without coordinates adds exactly one work time to the previous arrival.
        assertThat(Duration.between(etas[1], etas[2])).isEqualTo(Duration.ofMinutes(5))
        assertThat(reply.body.path("next").path("stopId").asString()).isEqualTo("A")
        assertThat(reply.body.path("next").path("eta").asString()).isEqualTo(stops.first().path("eta").asString())
        assertThat(f.driver.queries.route(DRIVER_DATE, "G1").path("next").path("eta").asString())
            .isEqualTo(stops.first().path("eta").asString())
        assertThat(f.driver.queries.stop(DRIVER_DATE, "G1", "B").path("eta").asString())
            .isEqualTo(stops[1].path("eta").asString())
        assertThat(f.snapshotEta().path("stops")).hasSize(4)
        assertThat(f.snapshotEta().path("reason").asString()).isEqualTo("departed")
    }

    @Test
    fun `a resend leaves the stored eta and the outbox as they were and a restart keeps them`() {
        val f = fixture()
        val body = envelope("e-depart", "departed", "{}", location = true)
        f.driver.activity.acceptEvent(DRIVER_DATE, body)
        val first = f.checkpoint()
        f.now.addAndGet(120_000)
        assertThat(f.driver.activity.acceptEvent(DRIVER_DATE, body).duplicate).isTrue()
        assertThat(f.checkpoint().path("etas")).isEqualTo(first.path("etas"))
        assertThat(f.checkpoint().path("outbox")).isEqualTo(first.path("outbox"))
        assertThat(f.etaMessages()).hasSize(1)

        val route = f.restarted().driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("stops").toList().map { it.path("eta").asString() })
            .isEqualTo(first.path("etas").path("G1").path("stops").toList().map { it.path("eta").asString() })
    }

    @Test
    fun `the departure leaves one eta message with the contract body`() {
        val f = fixture()
        f.send("e-depart", "departed", "{}", location = true)
        val message = f.etaMessages().single()
        val revision = f.checkpoint().path("revision").asLong()
        assertThat(message.path("messageId").asString()).isEqualTo("$DRIVER_DATE-$revision-eta-G1")
        assertThat(message.path("body").path("messageId").asString()).isEqualTo(message.path("messageId").asString())
        val body = message.path("body")
        assertThat(body.properties().map { it.key })
            .containsExactlyInAnyOrder("messageId", "vehicleId", "computedAt", "reason", "stops")
        assertThat(body.path("vehicleId").asString()).isEqualTo("G1")
        assertThat(body.path("reason").asString()).isEqualTo("departed")
        assertThat(OffsetDateTime.parse(body.path("computedAt").asString()).offset.totalSeconds).isEqualTo(9 * 3600)
        assertThat(body.path("stops").toList().map { it.path("sequence").asInt() }).containsExactly(1, 2, 3, 4)
        assertThat(body.path("stops").toList().map { it.path("orderIds").toList().map(JsonNode::asString) })
            .containsExactly(listOf("A"), listOf("B"), listOf("C"), listOf("D"))
        assertThat(body.path("stops").first().properties().map { it.key })
            .containsExactlyInAnyOrder("sequence", "orderIds", "eta")
        assertThat(message.path("sentAt").isNull).isTrue()
    }

    @Test
    fun `the settings move the eta`() {
        val slow = fixture()
        slow.send("e-depart", "departed", "{}", location = true)
        val fast = fixture(EtaConfig(speedKmh = 60.0), "fast")
        fast.send("e-depart", "departed", "{}", location = true)
        fun last(f: RouteFixture) =
            f.driver.queries.route(DRIVER_DATE, "G1").path("stops").last().path("eta").asString()
        assertThat(OffsetDateTime.parse(last(fast))).isBefore(OffsetDateTime.parse(last(slow)))
    }

    @Test
    fun `a device clock far from the server is not trusted and the source is stored`() {
        val near = fixture()
        near.send("e-near", "departed", "{}", location = true, occurredAt = "2026-10-13T10:03:00+09:00")
        assertThat(near.snapshotEta().path("departureTimeSource").asString()).isEqualTo("device")
        assertThat(near.snapshotEta().path("departedAt").asString()).isEqualTo("2026-10-13T10:03:00+09:00")

        val far = fixture(name = "far")
        far.send("e-far", "departed", "{}", location = true, occurredAt = "2026-10-13T08:00:00+09:00")
        assertThat(far.snapshotEta().path("departureTimeSource").asString()).isEqualTo("server")
        assertThat(far.snapshotEta().path("departedAt").asString()).isEqualTo("2026-10-13T10:00:00+09:00")
        val firstEta = OffsetDateTime.parse(far.snapshotEta().path("stops").first().path("eta").asString())
        assertThat(firstEta).isAfterOrEqualTo(OffsetDateTime.parse("2026-10-13T10:00:00+09:00"))
    }

    @Test
    fun `without an origin the first stop arrives at the departure and is not estimated`() {
        val f = fixture()
        f.send("e-depart", "departed", "{}", location = false, occurredAt = "2026-10-13T10:00:00+09:00")
        val first = f.snapshotEta().path("stops").first()
        assertThat(first.path("estimated").asBoolean()).isFalse()
        assertThat(first.path("eta").asString()).isEqualTo("2026-10-13T10:00:00+09:00")
        assertThat(f.snapshotEta().path("stops")[1].path("estimated").asBoolean()).isTrue()
    }

    private fun RouteFixture.send(
        id: String,
        type: String,
        payload: String,
        location: Boolean = false,
        occurredAt: String = "2026-10-13T10:00:00+09:00",
    ) = driver.activity.acceptEvent(DRIVER_DATE, envelope(id, type, payload, location, occurredAt))

    private fun envelope(
        id: String,
        type: String,
        payload: String,
        location: Boolean = false,
        occurredAt: String = "2026-10-13T10:00:00+09:00",
    ): ObjectNode = (driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"$occurredAt",
        "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode).also {
        // 0.05 degrees west of the first stop, so the first leg is a few kilometres.
        if (location) it.set("location", driverJson.readTree("""{"lat":37.5,"lng":127.0,"accuracyM":8}"""))
    }

    private fun RouteFixture.checkpoint() = driverJson.readTree(state.resolve("$DRIVER_DATE.json").toFile())

    private fun RouteFixture.etaMessages() =
        checkpoint().path("outbox").toList().filter { it.path("kind").asString() == "eta" }

    private fun RouteFixture.snapshotEta() =
        dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").path("eta")
}
