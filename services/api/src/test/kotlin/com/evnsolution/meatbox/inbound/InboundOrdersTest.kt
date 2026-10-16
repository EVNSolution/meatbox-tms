package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.dispatchMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Path
import java.time.Instant

class InboundOrdersTest {
    @TempDir lateinit var directory: Path

    private val now = Instant.parse("2026-10-13T01:00:00Z").toEpochMilli()

    private fun inbound(sub: String = "a") = InboundOrders(directory.toRealPath().resolve(sub), groupCount = 3) { now }

    /** Plans a message and writes the file the way the store does. */
    private fun InboundOrders.send(order: InboundOrder, phase: String = "unplanned", done: Set<String> = emptySet()) =
        plan(order, phase, done).also { it.file?.let(::write) }

    private fun InboundOrders.sourceId() = source(INBOUND_DATE)!!.sourceId

    private fun InboundOrders.day() = dispatchMapper.readTree(source(INBOUND_DATE)!!.day)

    @Test
    fun `maps the contract body to a dispatch order`() {
        val parsed = InboundOrder.parse(orderBody("MB-1", boxes = 2))
        val order = parsed.order!!
        assertThat(order.path("id").asString()).isEqualTo("MB-1")
        assertThat(order.path("name").asString()).isEqualTo("가게 MB-1")
        assertThat(order.path("address").asString()).isEqualTo("서울 강남구 MB-1")
        assertThat(order.path("detailAddress").asString()).isEqualTo("지하 1층")
        assertThat(order.path("boxes").isIntegralNumber).isTrue()
        assertThat(order.path("boxes").asInt()).isEqualTo(2)
        assertThat(order.path("coordinates").toList().map { it.asDouble() }).containsExactly(127.0, 37.5)
        assertThat(order.path("deliveryType").asString()).isEqualTo("fresh")
        assertThat(order.path("sourceVersion").asInt()).isEqualTo(1)
        assertThat(order.path("access").path("entranceCode").asString()).isEqualTo("1234*")
        assertThat(order.path("items").first().path("barcode").asString()).isEqualTo("8801234567890")
        assertThat(order.has("phone")).isFalse()
        assertThat(parsed.phone).isEqualTo("010-0000-0000")
    }

    @Test
    fun `sums boxes over items and leaves coordinates out when they are missing`() {
        val body = orderBody("A").apply {
            (path("address") as ObjectNode).putNull("lat").putNull("lng")
            set("items", dispatchMapper.readTree("""[{"sku":"a","qty":1,"boxes":1.5},{"sku":"b","qty":1,"boxes":2}]"""))
        }
        val order = InboundOrder.parse(body).order!!
        assertThat(order.path("boxes").asDouble()).isEqualTo(3.5)
        assertThat(order.path("coordinates").isNull).isTrue()
        assertThat(order.path("zoneIds").isArray).isTrue()
    }

    @Test
    fun `a cancellation needs only identity, version, status and date`() {
        val cancelled = InboundOrder.parse(orderBody("A", version = 2, status = "cancelled"))
        assertThat(cancelled.order).isNull()
        assertThat(cancelled.status).isEqualTo("cancelled")
    }

    @Test
    fun `rejects malformed bodies`() {
        val broken = listOf<(ObjectNode) -> Unit>(
            { it.put("orderId", "a/b") },
            { it.put("version", 0) },
            { it.put("version", "1") },
            { it.put("status", "paused") },
            { it.put("deliveryDate", "2026-02-30") },
            { it.put("deliveryType", "air") },
            { it.remove("items") },
            { it.set("items", dispatchMapper.createArrayNode()) },
            { (it.path("address") as ObjectNode).putNull("lng") },
            { (it.path("address") as ObjectNode).put("lat", 91) },
            { (it.path("customer") as ObjectNode).put("name", " ") },
            { it.set("items", dispatchMapper.readTree("""[{"sku":"a","qty":1,"boxes":-1}]""")) },
        )
        for (change in broken) {
            val body = orderBody("A").also(change)
            assertThatThrownBy { InboundOrder.parse(body) }.isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(400)
                assertThat(it.code).isEqualTo("INVALID_ORDER")
            }
        }
    }

    @Test
    fun `before planning, a new, changed and cancelled order is applied and the source id follows`() {
        val inbound = inbound()
        inbound.send(order("A")).receipt.let {
            assertThat(it.state).isEqualTo("accepted")
            assertThat(it.applied).isTrue()
            assertThat(it.held).isNull()
        }
        inbound.send(order("B"))
        val two = inbound.sourceId()
        assertThat(inbound.day().path("orders").size()).isEqualTo(2)
        assertThat(inbound.day().path("groups").size()).isEqualTo(3)
        assertThat(inbound.day().path("orders").first().path("groupId").asString()).isEqualTo("api-g01")

        inbound.send(order("B", version = 2, boxes = 5))
        assertThat(inbound.day().path("orders").toList().last().path("boxes").asInt()).isEqualTo(5)
        assertThat(inbound.sourceId()).isNotEqualTo(two)

        inbound.send(order("A", version = 2, status = "cancelled"))
        assertThat(inbound.day().path("orders").toList().map { it.path("id").asString() }).containsExactly("B")
        assertThat(inbound.summary(INBOUND_DATE)!!.path("received").asInt()).isEqualTo(2)
        assertThat(inbound.summary(INBOUND_DATE)!!.path("applied").asInt()).isEqualTo(1)
    }

    @Test
    fun `the source id depends on the applied set, not on arrival order`() {
        val first = inbound("one").apply { send(order("A")); send(order("B")); send(order("B", 2)) }
        val second = inbound("two").apply { send(order("B")); send(order("A")); send(order("B", 2)) }
        assertThat(first.sourceId()).startsWith("api-").isEqualTo(second.sourceId())
        val third = inbound("three").apply { send(order("A")); send(order("B")) }
        assertThat(third.sourceId()).isNotEqualTo(first.sourceId())
    }

    @Test
    fun `repeats and older versions change nothing and a different body for one version conflicts`() {
        val inbound = inbound()
        inbound.send(order("A", version = 2))
        val stamp = inbound.summary(INBOUND_DATE)!!.path("stamp").asLong()

        assertThat(inbound.send(order("A", version = 2)).receipt.state).isEqualTo("duplicate")
        val older = inbound.send(order("A", version = 1))
        assertThat(older.receipt.state).isEqualTo("ignored")
        assertThat(older.file).isNull()
        assertThat(inbound.summary(INBOUND_DATE)!!.path("stamp").asLong()).isEqualTo(stamp)

        assertThatThrownBy { inbound.send(order("A", version = 2, boxes = 9)) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(409)
                assertThat(it.code).isEqualTo("ORDER_VERSION_CONFLICT")
            }
    }

    @Test
    fun `a change during a draft applies and asks for the draft to go, with a warning`() {
        val inbound = inbound()
        inbound.send(order("A"))
        inbound.send(order("B"))
        val before = inbound.sourceId()

        val moved = inbound.send(order("B", 2, boxes = 7), phase = "draft")
        assertThat(moved.resetDraft).isTrue()
        assertThat(moved.receipt.draftReset).isTrue()
        assertThat(inbound.sourceId()).isNotEqualTo(before)
        val warnings = inbound.summary(INBOUND_DATE)!!.path("warnings").toList()
        assertThat(warnings.map { it.path("code").asString() }).containsExactly("DRAFT_RESET_BY_INBOUND")
        assertThat(warnings.single().path("orderId").asString()).isEqualTo("B")
        assertThat(warnings.single().path("version").asInt()).isEqualTo(2)

        // A cancellation of an order that was never in the plan leaves the draft alone.
        val harmless = inbound.send(order("Z", 1, status = "cancelled"), phase = "draft")
        assertThat(harmless.resetDraft).isFalse()
    }

    @Test
    fun `after confirmation the plan's orders stay and each change becomes a warning`() {
        val inbound = inbound()
        inbound.send(order("A"))
        inbound.send(order("B"))
        inbound.send(order("C"))
        val sourceId = inbound.sourceId()
        val dayBefore = inbound.day()

        fun held(order: InboundOrder, phase: String, done: Set<String> = emptySet()): String? {
            val out = inbound.send(order, phase, done)
            assertThat(out.receipt.applied).isFalse()
            assertThat(out.resetDraft).isFalse()
            return out.receipt.held
        }
        assertThat(held(order("A", 2, boxes = 9), "published")).isEqualTo("ORDER_CHANGED_AFTER_DISPATCH")
        assertThat(held(order("B", 2, status = "cancelled"), "amending")).isEqualTo("ORDER_CANCELLED_AFTER_DISPATCH")
        assertThat(held(order("C", 2, boxes = 9), "published", done = setOf("C")))
            .isEqualTo("ORDER_CHANGED_AFTER_COMPLETION")
        assertThat(held(order("C", 3, status = "cancelled"), "published", done = setOf("C")))
            .isEqualTo("ORDER_CHANGED_AFTER_COMPLETION")
        assertThat(held(order("N"), "published")).isEqualTo("ORDER_ADDED_AFTER_DISPATCH")
        assertThat(held(order("M", 1, status = "cancelled"), "published")).isNull()

        assertThat(inbound.sourceId()).isEqualTo(sourceId)
        assertThat(inbound.day()).isEqualTo(dayBefore)
        assertThat(inbound.summary(INBOUND_DATE)!!.path("warnings").toList().map { it.path("code").asString() })
            .containsExactly(
                "ORDER_CHANGED_AFTER_DISPATCH", "ORDER_CANCELLED_AFTER_DISPATCH", "ORDER_CHANGED_AFTER_COMPLETION",
                "ORDER_CHANGED_AFTER_COMPLETION", "ORDER_ADDED_AFTER_DISPATCH",
            )
        // The received version moved on, so an old resend is ignored rather than warned about again.
        assertThat(inbound.send(order("A", 2, boxes = 9), "published").receipt.state).isEqualTo("duplicate")
    }

    @Test
    fun `rejects past dates, moved orders and a full day`() {
        val inbound = inbound()
        assertThatThrownBy { inbound.send(order("A", date = "2026-10-12")) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.status).isEqualTo(422)
                assertThat(it.code).isEqualTo("DELIVERY_DATE_PAST")
            }
        inbound.send(order("A"))
        assertThatThrownBy { inbound.send(order("A", version = 2, date = "2026-10-15")) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DELIVERY_DATE_CHANGE_UNSUPPORTED")
            }
        // A new process finds the same order again from the files.
        val restarted = InboundOrders(directory.toRealPath().resolve("a"), groupCount = 3) { now }
        assertThatThrownBy { restarted.send(order("A", version = 2, date = "2026-10-15")) }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DELIVERY_DATE_CHANGE_UNSUPPORTED")
            }
        assertThat(restarted.dates()).containsExactly(INBOUND_DATE)
    }
}
