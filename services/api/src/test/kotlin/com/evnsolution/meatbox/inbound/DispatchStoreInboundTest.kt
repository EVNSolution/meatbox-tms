package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.compat.CompatSettings
import com.evnsolution.meatbox.compat.DispatchDataException
import com.evnsolution.meatbox.compat.DispatchDataReader
import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.dispatch.dispatchMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Assumptions.assumeFalse
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant

class DispatchStoreInboundTest {
    @TempDir lateinit var temp: Path

    private val root get() = temp.toRealPath()
    private val now = Instant.parse("2026-10-13T01:00:00Z").toEpochMilli()

    private fun store(): DispatchStore {
        Files.createDirectories(root.resolve("data/days"))
        Files.createDirectories(root.resolve("state"))
        if (!Files.exists(root.resolve("data/manifest.json"))) {
            Files.writeString(
                root.resolve("data/manifest.json"),
                manifest(CSV_DATE),
            )
            Files.writeString(
                root.resolve("data/days/$CSV_DATE.json"),
                """{"schemaVersion":1,"date":"$CSV_DATE","summary":{"orders":1,"boxes":1},
                  "groups":[{"id":"G1","label":"합성 기사","regionNames":["권역"]}],
                  "orders":[{"id":"O1","groupId":"G1","name":"합성","address":"합성 주소","boxes":1,"sourceRows":1,
                  "sequence":1,"coordinates":[127.0,37.5],"zoneIds":["Z1"]}]}""",
            )
        }
        val inbound = InboundOrders(root.resolve("state/inbound"), groupCount = 4) { now }
        val reader = DispatchDataReader(CompatSettings(URI("http://127.0.0.1:1"), root.resolve("data")), inbound)
        return DispatchStore(reader, root.resolve("state"), { now }, inbound)
    }

    private fun command(store: DispatchStore, type: String, revision: Long, vararg extra: Pair<String, Any>) =
        store.command(
            INBOUND_DATE,
            dispatchMapper.createObjectNode().put("type", type).put("expectedBoot", store.boot)
                .put("expectedRevision", revision).apply {
                    extra.forEach { (key, value) ->
                        when (value) {
                            is Int -> put(key, value)
                            is List<*> -> set(key, dispatchMapper.createArrayNode().addAll(value.map { v -> text(v) }))
                        }
                    }
                },
        )

    private fun text(value: Any?) = dispatchMapper.stringNode("$value")

    private fun calculate(store: DispatchStore) =
        command(store, "calculate_dispatch", 0, "vehicleIds" to listOf("api-g01", "api-g02"))

    private fun publish(store: DispatchStore) = command(store, "publish_dispatch", 1, "draftVersion" to 1)

    private fun ids(snapshot: ObjectNode) = snapshot.path("dispatchOrders").toList().map { it.path("id").asString() }

    private fun checkpoint() = root.resolve("state/$INBOUND_DATE.json")

    @Test
    fun `three received orders become the day's dispatch orders with a stable source id`() {
        val store = store()
        listOf("A", "B", "C").forEach { assertThat(store.receiveOrder(order(it)).state).isEqualTo("accepted") }

        val snapshot = store.snapshot(INBOUND_DATE)
        assertThat(ids(snapshot)).containsExactly("A", "B", "C")
        assertThat(snapshot.path("dispatch").path("phase").asString()).isEqualTo("unplanned")
        assertThat(snapshot.path("dispatchCandidates").size()).isEqualTo(4)
        val sourceId = snapshot.path("sourceData").path("sourceId").asString()
        assertThat(sourceId).startsWith("api-")
        val inbound = snapshot.path("sourceData").path("inbound")
        assertThat(inbound.path("received").asInt()).isEqualTo(3)
        assertThat(inbound.path("applied").asInt()).isEqualTo(3)

        // Another process sees the same orders and the same id.
        assertThat(store().snapshot(INBOUND_DATE).path("sourceData").path("sourceId").asString()).isEqualTo(sourceId)
    }

    @Test
    fun `a repeat is a duplicate, a lower version is ignored and a changed body conflicts`() {
        val store = store()
        store.receiveOrder(order("A", version = 2))
        val file = root.resolve("state/inbound/$INBOUND_DATE.json")
        val bytes = Files.readAllBytes(file)

        assertThat(store.receiveOrder(order("A", version = 2)).state).isEqualTo("duplicate")
        assertThat(store.receiveOrder(order("A", version = 1)).state).isEqualTo("ignored")
        assertThat(Files.readAllBytes(file)).isEqualTo(bytes)
        assertThatThrownBy { store.receiveOrder(order("A", version = 2, boxes = 9)) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(409)
                assertThat(it.code).isEqualTo("ORDER_VERSION_CONFLICT")
            }
        assertThat(Files.readAllBytes(file)).isEqualTo(bytes)
    }

    @Test
    fun `a cancellation before dispatch removes the order`() {
        val store = store()
        listOf("A", "B", "C").forEach { store.receiveOrder(order(it)) }
        val receipt = store.receiveOrder(order("B", version = 2, status = "cancelled"))
        assertThat(receipt.applied).isTrue()
        assertThat(ids(store.snapshot(INBOUND_DATE))).containsExactly("A", "C")
    }

    @Test
    fun `a change during a draft drops the draft and says why`() {
        val store = store()
        listOf("A", "B", "C").forEach { store.receiveOrder(order(it)) }
        calculate(store)
        assertThat(Files.exists(checkpoint())).isTrue()

        val receipt = store.receiveOrder(order("C", version = 2, boxes = 6))

        assertThat(receipt.draftReset).isTrue()
        assertThat(Files.exists(checkpoint())).isFalse()
        val snapshot = store.snapshot(INBOUND_DATE)
        assertThat(snapshot.path("dispatch").path("phase").asString()).isEqualTo("unplanned")
        assertThat(snapshot.path("dispatchOrders").toList().first { it.path("id").asString() == "C" }
            .path("boxes").asInt()).isEqualTo(6)
        val warning = snapshot.path("sourceData").path("inbound").path("warnings").single()
        assertThat(warning.path("code").asString()).isEqualTo("DRAFT_RESET_BY_INBOUND")
        assertThat(warning.path("orderId").asString()).isEqualTo("C")
        // The operator can plan again on the new orders.
        assertThat(calculate(store).path("state").path("dispatch").path("phase").asString()).isEqualTo("draft")
    }

    @Test
    fun `after confirmation a cancel or a change keeps the order and the state and leaves a warning`() {
        val store = store()
        listOf("A", "B", "C").forEach { store.receiveOrder(order(it)) }
        calculate(store)
        publish(store)
        val before = store.snapshot(INBOUND_DATE)
        val checkpointBytes = Files.readAllBytes(checkpoint())

        val cancel = store.receiveOrder(order("B", version = 2, status = "cancelled"))
        val change = store.receiveOrder(order("A", version = 2, boxes = 9))
        val added = store.receiveOrder(order("D"))

        assertThat(listOf(cancel.held, change.held, added.held)).containsExactly(
            "ORDER_CANCELLED_AFTER_DISPATCH", "ORDER_CHANGED_AFTER_DISPATCH", "ORDER_ADDED_AFTER_DISPATCH",
        )
        assertThat(listOf(cancel, change, added).none { it.applied || it.draftReset }).isTrue()
        val after = store.snapshot(INBOUND_DATE)
        assertThat(ids(after)).containsExactly("A", "B", "C")
        assertThat(after.path("dispatch").path("phase").asString()).isEqualTo("published")
        assertThat(after.path("revision")).isEqualTo(before.path("revision"))
        assertThat(after.path("sourceData").path("sourceId")).isEqualTo(before.path("sourceData").path("sourceId"))
        assertThat(after.path("fleetDeliveries")).isEqualTo(before.path("fleetDeliveries"))
        assertThat(Files.readAllBytes(checkpoint())).isEqualTo(checkpointBytes)
        val inbound = after.path("sourceData").path("inbound")
        assertThat(inbound.path("warnings").toList().map { it.path("code").asString() }).containsExactly(
            "ORDER_CANCELLED_AFTER_DISPATCH", "ORDER_CHANGED_AFTER_DISPATCH", "ORDER_ADDED_AFTER_DISPATCH",
        )
        // The change stamp moves, so the web's conditional state request sees the new warnings.
        val oldStamp = before.path("sourceData").path("inbound").path("stamp").asLong()
        assertThat(inbound.path("stamp").asLong()).isGreaterThan(oldStamp)

        // A restart restores the confirmed day over the same orders.
        val restarted = store().snapshot(INBOUND_DATE)
        assertThat(ids(restarted)).containsExactly("A", "B", "C")
        assertThat(restarted.path("dispatch").path("phase").asString()).isEqualTo("published")
    }

    @Test
    fun `a date that the prepared bundle has refuses pushed orders and keeps its snapshot bytes`() {
        val store = store()
        val csv = store.snapshot(CSV_DATE)
        assertThat(csv.path("sourceData").has("inbound")).isFalse()
        assertThatThrownBy { store.receiveOrder(order("A", date = CSV_DATE)) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(409)
                assertThat(it.code).isEqualTo("SOURCE_CONFLICT")
            }
        assertThat(store.snapshot(CSV_DATE)).isEqualTo(csv)
    }

    @Test
    fun `a pushed file that appears for a prepared date closes the date instead of choosing a source`() {
        val store = store()
        store.receiveOrder(order("A"))
        Files.writeString(
            root.resolve("data/manifest.json"),
            manifest(CSV_DATE, INBOUND_DATE),
        )
        Files.writeString(
            root.resolve("data/days/$INBOUND_DATE.json"),
            """{"schemaVersion":1,"date":"$INBOUND_DATE","groups":[],"orders":[]}""",
        )
        assertThatThrownBy { store.snapshot(INBOUND_DATE) }
            .isInstanceOfSatisfying(DispatchDataException::class.java) {
                assertThat(it.status.value()).isEqualTo(500)
                assertThat(it.code).isEqualTo("DISPATCH_SOURCE_CONFLICT")
            }
    }

    @Test
    fun `a failed write after a draft was dropped leaves the old orders without a draft`() {
        assumeFalse(System.getProperty("user.name") == "root", "root ignores directory permissions")
        val store = store()
        listOf("A", "B").forEach { store.receiveOrder(order(it)) }
        calculate(store)
        val inboundDirectory = root.resolve("state/inbound")
        val sourceId = store.snapshot(INBOUND_DATE).path("sourceData").path("sourceId")

        Files.setPosixFilePermissions(inboundDirectory, PosixFilePermissions.fromString("r-x------"))
        try {
            assertThatThrownBy { store.receiveOrder(order("B", version = 2, boxes = 8)) }
                .isInstanceOfSatisfying(DispatchException::class.java) {
                    assertThat(it.status).isEqualTo(500)
                    assertThat(it.code).isEqualTo("INBOUND_WRITE_FAILED")
                }
        } finally {
            Files.setPosixFilePermissions(inboundDirectory, PosixFilePermissions.fromString("rwx------"))
        }

        val snapshot = store.snapshot(INBOUND_DATE)
        assertThat(snapshot.path("dispatch").path("phase").asString()).isEqualTo("unplanned")
        assertThat(snapshot.path("sourceData").path("sourceId")).isEqualTo(sourceId)
        assertThat(snapshot.path("dispatchOrders").toList().first { it.path("id").asString() == "B" }
            .path("boxes").asInt()).isEqualTo(2)
        // The sender retries the same message and it lands.
        assertThat(store.receiveOrder(order("B", version = 2, boxes = 8)).state).isEqualTo("accepted")
    }

    @Test
    fun `without an inbound module the store refuses pushed orders`() {
        Files.createDirectories(root.resolve("state"))
        val reader = DispatchDataReader(CompatSettings(URI("http://127.0.0.1:1"), root.resolve("data")))
        val bare = DispatchStore(reader, root.resolve("state"))
        assertThatThrownBy { bare.receiveOrder(order("A")) }.isInstanceOf(DispatchException::class.java)
    }

    private fun manifest(vararg dates: String) = """{"schemaVersion":1,"defaultDate":"$CSV_DATE",""" +
        """"dates":[${dates.joinToString(",") { """{"date":"$it"}""" }}],"source":{"csvSha256":"fixture"}}"""

    companion object {
        private const val CSV_DATE = "2026-10-13"
    }
}
