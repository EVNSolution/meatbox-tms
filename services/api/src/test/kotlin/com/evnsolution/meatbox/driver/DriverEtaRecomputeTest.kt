package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxOutcome
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.atomic.AtomicLong

/**
 * ETA after the departure. Server clock starts at 10:00 KST. Stops A (127.05), B (127.10), C (no coordinates) and
 * D (127.15) lie on 37.5 N, the truck leaves from 127.0. A leg of 0.05 degrees takes 14.8 minutes (1.4 x 4.41 km at
 * 25 km/h) and every stop takes 5 minutes, so the departure ETA is A 10:15, B 10:35, C 10:40, D 10:59.
 */
class DriverEtaRecomputeTest {
    @TempDir lateinit var directory: Path

    private val zoneA = """{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"zoneId":"Z-A"},
        "geometry":{"type":"Polygon","coordinates":[[[126.9,37.4],[127.1,37.4],[127.1,37.6],[126.9,37.6],[126.9,37.4]]]}}]}"""

    private fun fixture(name: String = "base"): RouteFixture {
        val root = Files.createDirectories(directory.resolve(name)).toRealPath()
        Files.createDirectories(root.resolve("data/days"))
        Files.writeString(root.resolve("data/regions.geojson"), zoneA)
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
        val f = RouteFixture.open(root, AtomicLong(Instant.parse("${DRIVER_DATE}T01:00:00Z").toEpochMilli()))
        fun run(command: ObjectNode) = f.dispatch.command(DRIVER_DATE, command.put("expectedBoot", f.dispatch.boot))
        run(driverJson.createObjectNode().put("type", "calculate_dispatch").put("expectedRevision", 0)
            .set("vehicleIds", driverJson.createArrayNode().add("G1")))
        run(
            driverJson.createObjectNode().put("type", "publish_dispatch").put("expectedRevision", 1)
                .put("draftVersion", 1),
        )
        return f
    }

    private fun departed(f: RouteFixture) = f.send("e-depart", "departed", "{}", "10:00", location = true)

    @Test
    fun `an on time completion refreshes the stored eta and keeps history but owes no message`() {
        val f = fixture()
        departed(f)
        val reply = f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:20")

        val eta = f.eta()
        assertThat(eta.path("reason").asString()).isEqualTo("completed")
        assertThat(eta.path("recomputes").asInt()).isEqualTo(1)
        val stops = eta.path("stops").toList()
        assertThat(stops.map { it.path("stopId").asString() }).containsExactly("A", "B", "C", "D")
        assertThat(stops.map { it.path("sequence").asInt() }).containsExactly(1, 2, 3, 4)
        assertThat(stops[0].path("eta").asString()).isEqualTo("2026-10-13T10:15:00+09:00")
        assertThat(stops[0].path("actualAt").asString()).isEqualTo("2026-10-13T10:20:00+09:00")
        assertThat(stops.drop(1).map { it.has("actualAt") }).containsOnly(false)
        // The event has no position, so the leg starts at A: 10:20 + 14.8 minutes, as the departure ETA had it.
        assertThat(stops[1].path("eta").asString()).isEqualTo("2026-10-13T10:35:00+09:00")
        assertThat(reply.body.path("next").path("eta").asString()).isEqualTo(stops[1].path("eta").asString())
        assertThat(f.etaMessages()).hasSize(1)
        assertThat(f.etaMessages().single().path("body").path("reason").asString()).isEqualTo("departed")
    }

    @Test
    fun `the reported position anchors the legs and a large shift is sent even when the stop closed on time`() {
        val f = fixture()
        departed(f)
        f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:20", location = true)
        // The event reports 127.0, so the leg to B is 2 x 4.4 km: 10:20 + 29.6 minutes.
        assertThat(f.eta().path("stops")[1].path("eta").asString()).isEqualTo("2026-10-13T10:50:00+09:00")
        assertThat(f.eta().path("reason").asString()).isEqualTo("completed")
        val message = f.etaMessages().single()
        assertThat(message.path("body").path("reason").asString()).isEqualTo("completed")
        assertThat(message.path("body").path("stops")[0].path("eta").asString()).isEqualTo("2026-10-13T10:50:00+09:00")
    }

    @Test
    fun `a late completion is delayed and replaces the unsent message`() {
        val f = fixture()
        departed(f)
        f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:50", location = true)
        assertThat(f.eta().path("reason").asString()).isEqualTo("delayed")
        val messages = f.etaMessages()
        assertThat(messages).hasSize(1)
        val message = messages.single()
        assertThat(message.path("messageId").asString()).endsWith("-eta-G1-r1")
        assertThat(message.path("body").path("reason").asString()).isEqualTo("delayed")
        assertThat(message.path("body").path("stops").toList().map { it.path("sequence").asInt() })
            .containsExactly(2, 3, 4)
        assertThat(message.path("body").path("stops")[0].path("orderIds").toList().map(JsonNode::asString))
            .containsExactly("B")
        assertThat(f.outboxIds()).doesNotHaveDuplicates()
    }

    @Test
    fun `an early completion is delayed too and a sent message is followed by a new one`() {
        val f = fixture()
        departed(f)
        val first = f.dispatch.dueOutbox(f.now.get(), 10).single { it.kind == "eta" }
        f.dispatch.recordOutbox(first, OutboxOutcome.SENT, "202", f.now.get(), f.now.get())
        f.send("e-a", "stop_failed", """{"stopId":"A","reasonCode":"ABSENT"}""", "10:01")
        assertThat(f.eta().path("reason").asString()).isEqualTo("delayed")
        assertThat(f.etaMessages().map { it.path("body").path("reason").asString() })
            .containsExactly("departed", "delayed")
        assertThat(f.etaMessages().map { it.path("sentAt").isNull }).containsExactly(false, true)
        assertThat(f.outboxIds()).doesNotHaveDuplicates()
    }

    @Test
    fun `small shifts add up against the last sent eta and then send`() {
        val f = fixture()
        departed(f)
        // A closes 7 minutes after its due time 10:20, B's new ETA moves by 7 minutes: below the threshold.
        f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:27")
        assertThat(f.eta().path("reason").asString()).isEqualTo("completed")
        assertThat(f.etaMessages()).hasSize(1)
        // B closes 7 minutes after its due time 10:47; C and D are now 13 minutes past what Meatbox was told.
        f.send("e-b", "stop_completed", """{"stopId":"B"}""", "10:54")
        assertThat(f.eta().path("reason").asString()).isEqualTo("completed")
        val message = f.etaMessages().single()
        assertThat(message.path("body").path("reason").asString()).isEqualTo("completed")
        assertThat(message.path("body").path("stops").toList().map { it.path("sequence").asInt() })
            .containsExactly(3, 4)
        // After it went out, the reported times are the new ones: another small change stays quiet.
        val reported = f.eta().path("reported")
        assertThat(reported.toList().map { it.path("stopId").asString() }).containsExactly("C", "D")
    }

    @Test
    fun `the last stop closing updates the eta but owes nothing`() {
        val f = fixture()
        departed(f)
        listOf("A", "B", "C").forEachIndexed { index, id ->
            f.send("e-$id", "stop_completed", """{"stopId":"$id"}""", "10:%02d".format(20 + index * 5), location = true)
        }
        val before = f.outboxIds()
        f.send("e-D", "stop_completed", """{"stopId":"D"}""", "10:35", location = true)
        assertThat(f.outboxIds().filter { "-eta-" in it }).isEqualTo(before.filter { "-eta-" in it })
        assertThat(f.eta().path("stops").toList().map { it.has("actualAt") }).containsOnly(true)
        assertThat(f.eta().path("recomputes").asInt()).isEqualTo(4)
    }

    @Test
    fun `a vehicle that has no stored eta is not recomputed`() {
        val f = fixture()
        f.dispatch.command(
            DRIVER_DATE,
            driverJson.createObjectNode().put("type", "start_route").put("vehicleId", "G1")
                .put("expectedBoot", f.dispatch.boot).put("expectedRevision", f.checkpoint().path("revision").asLong()),
        )
        f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:50")
        assertThat(f.checkpoint().has("etas")).isFalse()
        assertThat(f.etaMessages()).isEmpty()
    }

    @Test
    fun `a resend changes nothing and a restart keeps the recomputed eta`() {
        val f = fixture()
        departed(f)
        val body = envelope("e-a", "stop_completed", """{"stopId":"A"}""", "10:50", location = true)
        f.now.set(Instant.parse("${DRIVER_DATE}T01:50:00Z").toEpochMilli())
        f.driver.activity.acceptEvent(DRIVER_DATE, body)
        val first = f.checkpoint()
        f.now.addAndGet(120_000)
        assertThat(f.driver.activity.acceptEvent(DRIVER_DATE, body).duplicate).isTrue()
        assertThat(f.checkpoint().path("etas")).isEqualTo(first.path("etas"))
        assertThat(f.checkpoint().path("outbox")).isEqualTo(first.path("outbox"))

        val route = f.restarted().driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("stops").toList().map { it.path("eta").asString() })
            .isEqualTo(first.path("etas").path("G1").path("stops").toList().map { it.path("eta").asString() })
        assertThat(f.restarted().dispatch.snapshot(DRIVER_DATE).path("vehicleStates").path("G1").path("eta")
            .path("reason").asString()).isEqualTo("delayed")
    }

    @Test
    fun `a checkpoint from before the recompute fields still recomputes and tells Meatbox`() {
        val f = fixture()
        departed(f)
        val file = f.state.resolve("$DRIVER_DATE.json")
        val saved = driverJson.readTree(file.toFile()) as ObjectNode
        (saved.path("etas").path("G1") as ObjectNode).remove(listOf("reported", "recomputes"))
        Files.write(file, driverJson.writeValueAsBytes(saved))
        val restarted = f.restarted()
        restarted.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:20")
        assertThat(restarted.eta().path("recomputes").asInt()).isEqualTo(1)
        assertThat(restarted.etaMessages().single().path("body").path("reason").asString()).isEqualTo("completed")
    }


    @Test
    fun `a zone entry inside its polygon recomputes from the position and tells Meatbox when the shift is large`() {
        val f = fixture()
        departed(f)
        val revision = f.checkpoint().path("revision").asLong()
        f.send("e-zone", "zone_entered", """{"zoneId":"Z-A"}""", "10:12", location = true)
        assertThat(f.checkpoint().path("revision").asLong()).isEqualTo(revision)
        assertThat(f.eta().path("reason").asString()).isEqualTo("zone_entered")
        // 12:00 + 14.8 minutes from the reported position, 12 minutes past the 10:15 that Meatbox was told.
        assertThat(f.eta().path("stops")[0].path("eta").asString()).isEqualTo("2026-10-13T10:27:00+09:00")
        val message = f.etaMessages().single()
        assertThat(message.path("body").path("reason").asString()).isEqualTo("zone_entered")
        assertThat(message.path("messageId").asString()).isEqualTo("$DRIVER_DATE-$revision-eta-G1-r1")
        assertThat(f.dispatch.snapshot(DRIVER_DATE).path("sourceData").path("etaVersion").asInt()).isEqualTo(1)
    }

    @Test
    fun `a zone entry that moves the eta a little updates it and stays quiet`() {
        val f = fixture()
        departed(f)
        f.send("e-zone", "zone_entered", """{"zoneId":"Z-A"}""", "10:03", location = true)
        assertThat(f.eta().path("reason").asString()).isEqualTo("zone_entered")
        assertThat(f.eta().path("stops")[0].path("eta").asString()).isEqualTo("2026-10-13T10:18:00+09:00")
        assertThat(f.etaMessages().single().path("body").path("reason").asString()).isEqualTo("departed")
    }

    @Test
    fun `a zone entry without a position or outside its polygon is refused and changes nothing`() {
        val f = fixture()
        departed(f)
        val before = Files.readAllBytes(f.state.resolve("$DRIVER_DATE.json"))
        assertCode(400, "LOCATION_REQUIRED") { f.send("e-none", "zone_entered", """{"zoneId":"Z-A"}""", "10:10") }
        val outside = envelope("e-out", "zone_entered", """{"zoneId":"Z-A"}""", "10:10")
        outside.set("location", driverJson.readTree("""{"lat":37.9,"lng":127.0}"""))
        assertCode(422, "ZONE_MISMATCH") { f.driver.activity.acceptEvent(DRIVER_DATE, outside) }
        assertThat(Files.readAllBytes(f.state.resolve("$DRIVER_DATE.json"))).isEqualTo(before)
        assertCode(404, "REQUEST_NOT_FOUND") { f.driver.activity.eventResult(DRIVER_DATE, "e-out") }
    }

    @Test
    fun `a zone without a polygon is only recorded and a resend changes nothing`() {
        val f = fixture()
        departed(f)
        val body = envelope("e-zone", "zone_entered", """{"zoneId":"Z-UNKNOWN"}""", "10:12", location = true)
        f.now.set(Instant.parse("${DRIVER_DATE}T01:12:00Z").toEpochMilli())
        assertThat(f.driver.activity.acceptEvent(DRIVER_DATE, body).body.path("accepted").asBoolean()).isTrue()
        val first = f.checkpoint()
        assertThat(f.driver.activity.acceptEvent(DRIVER_DATE, body).duplicate).isTrue()
        assertThat(f.checkpoint().path("etas")).isEqualTo(first.path("etas"))
        assertThat(f.checkpoint().path("outbox")).isEqualTo(first.path("outbox"))
    }

    @Test
    fun `a reorder after the departure moves only pending stops and recomputes with reason reordered`() {
        val f = fixture()
        departed(f)
        val order = """{"stopOrder":["A","D","C","B"],"expectedRevision":${f.revision()}}"""
        f.send("e-order", "route_reordered", order, "10:05", location = true)
        val route = f.driver.queries.route(DRIVER_DATE, "G1").path("stops").toList()
        assertThat(route.map { it.path("stopId").asString() }).containsExactly("A", "D", "C", "B")
        assertThat(f.eta().path("reason").asString()).isEqualTo("reordered")
        assertThat(f.eta().path("stops").toList().map { it.path("stopId").asString() })
            .containsExactly("A", "D", "C", "B")
        val message = f.etaMessages().single()
        assertThat(message.path("body").path("reason").asString()).isEqualTo("reordered")
        assertThat(message.path("body").path("stops").toList().map { it.path("orderIds")[0].asString() })
            .containsExactly("A", "D", "C", "B")
        assertThat(message.path("body").path("stops").toList().map { it.path("sequence").asInt() })
            .containsExactly(1, 2, 3, 4)
    }

    @Test
    fun `after a stop closed the closed and current stops hold their place`() {
        val f = fixture()
        departed(f)
        f.send("e-a", "stop_completed", """{"stopId":"A"}""", "10:20")
        val revision = f.revision()
        val before = Files.readAllBytes(f.state.resolve("$DRIVER_DATE.json"))
        listOf("""["B","A","C","D"]""", """["A","C","B","D"]""").forEachIndexed { index, order ->
            assertCode(409, "ROUTE_LOCKED") {
                f.send("e-l$index", "route_reordered", """{"stopOrder":$order}""", "10:21")
            }
        }
        assertThat(Files.readAllBytes(f.state.resolve("$DRIVER_DATE.json"))).isEqualTo(before)

        f.send("e-3", "route_reordered", """{"stopOrder":["A","B","D","C"],"expectedRevision":$revision}""", "10:21")
        val stops = f.eta().path("stops").toList()
        assertThat(stops.map { it.path("stopId").asString() }).containsExactly("A", "B", "D", "C")
        assertThat(stops.map { it.path("sequence").asInt() }).containsExactly(1, 2, 3, 4)
        assertThat(stops[0].path("actualAt").asString()).isEqualTo("2026-10-13T10:20:00+09:00")
        val stale = """{"stopOrder":["A","B","C","D"],"expectedRevision":$revision}"""
        assertCode(409, "REVISION_CONFLICT") { f.send("e-4", "route_reordered", stale, "10:22") }
    }

    @Test
    fun `a finished route cannot be reordered`() {
        val f = fixture()
        departed(f)
        listOf("A", "B", "C", "D").forEachIndexed { index, id ->
            f.send("e-$id", "stop_completed", """{"stopId":"$id"}""", "10:%02d".format(20 + index * 5))
        }
        assertCode(409, "ROUTE_LOCKED") {
            f.send("e-late", "route_reordered", """{"stopOrder":["D","C","B","A"]}""", "10:50")
        }
    }

    private fun assertCode(status: Int, code: String, action: () -> Unit) {
        assertThatThrownBy(action).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun RouteFixture.revision() = checkpoint().path("revision").asLong()

    private fun RouteFixture.send(
        id: String,
        type: String,
        payload: String,
        at: String,
        location: Boolean = false,
    ): DriverActivity.Reply {
        val (hour, minute) = at.split(":").map(String::toInt)
        val seconds = (hour - 10) * 3600L + minute * 60L
        now.set(Instant.parse("${DRIVER_DATE}T01:00:00Z").plusSeconds(seconds).toEpochMilli())
        return driver.activity.acceptEvent(DRIVER_DATE, envelope(id, type, payload, at, location))
    }

    private fun envelope(id: String, type: String, payload: String, at: String, location: Boolean = false) =
        (driverJson.readTree(
            """{"eventId":"$id","type":"$type","occurredAt":"${DRIVER_DATE}T$at:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
        ) as ObjectNode).also {
            if (location) it.set("location", driverJson.readTree("""{"lat":37.5,"lng":127.0,"accuracyM":8}"""))
        }

    private fun RouteFixture.checkpoint() = driverJson.readTree(state.resolve("$DRIVER_DATE.json").toFile())

    private fun RouteFixture.eta(): JsonNode = checkpoint().path("etas").path("G1")

    private fun RouteFixture.etaMessages() =
        checkpoint().path("outbox").toList().filter { it.path("kind").asString() == "eta" }

    private fun RouteFixture.outboxIds() = checkpoint().path("outbox").toList().map { it.path("messageId").asString() }
}
