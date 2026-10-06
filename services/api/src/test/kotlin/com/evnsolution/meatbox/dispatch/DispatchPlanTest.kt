@file:Suppress("MaxLineLength")

package com.evnsolution.meatbox.dispatch

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import tools.jackson.databind.node.ObjectNode
import java.time.Instant

class DispatchPlanTest {
    @Test
    fun `calculates a private draft then publishes an operational checkpoint without demo content`() {
        var now = Instant.parse("2026-09-16T01:00:00Z").toEpochMilli()
        val plan = DispatchPlan(day(), "csv-a", { ++now })

        val initial = plan.snapshot()
        assertThat(initial.at("/dispatch/phase").asString()).isEqualTo("unplanned")
        assertThat(initial.at("/dispatch/summary/destinations").asInt()).isEqualTo(3)
        assertThat(initial["fleetDeliveries"].isEmpty).isTrue()
        assertThat(initial.at("/dispatchCandidates/0").propertyNames())
            .containsExactlyInAnyOrder("id", "driver", "plate", "region", "locked")

        val calculated = send(plan, objectNode("type" to "calculate_dispatch").apply {
            set("vehicleIds", strings("G1", "G2"))
        })
        assertThat(calculated.at("/state/dispatch/phase").asString()).isEqualTo("draft")
        assertThat(calculated.at("/state/fleetDeliveries").isEmpty).isTrue()
        assertThat(calculated.at("/state/dispatchPreview/0/orders").asInt()).isGreaterThan(0)

        val published = send(plan, objectNode("type" to "publish_dispatch", "draftVersion" to 1))
        assertThat(published.at("/state/dispatch/phase").asString()).isEqualTo("published")
        assertThat(published.at("/state/fleetDeliveries").size()).isEqualTo(4)
        assertThat(published.at("/state/events").isEmpty).isTrue()
        assertThat(plan.exportCheckpoint().at("/confirmedEngineCheckpoint/presentationContentVersion").asInt()).isZero()
        assertThat(published.toString()).doesNotContain("demo-customer", "요청사항 예시", "synthetic")
    }

    @Test
    fun `moves complete destination bundles and keeps confirmed routes unchanged until republish`() {
        val plan = publishedPlan()
        val confirmed = copyNode(plan.snapshot()["fleetDeliveries"])

        send(plan, objectNode("type" to "begin_dispatch_revision"))
        val moved = send(plan, objectNode("type" to "reassign", "targetVehicleId" to "G2").apply {
            set("orderIds", strings("O1"))
        })

        assertThat(moved.at("/result/expandedOrderIds")).isEqualTo(strings("O1", "O2"))
        assertThat(moved.at("/state/dispatch/hasChanges").booleanValue()).isTrue()
        assertThat(moved.at("/state/fleetDeliveries")).isEqualTo(confirmed)
        assertThat(moved.at("/state/dispatchOrders/0/vehicleId").asString()).isEqualTo("G2")

        val currentDraftVersion = moved.at("/state/dispatch/draftVersion").asLong()
        val republished = send(plan, objectNode("type" to "publish_dispatch", "draftVersion" to currentDraftVersion))
        assertThat(republished.at("/result/amended").booleanValue()).isTrue()
        assertThat(republished.at("/state/fleetDeliveries").filter { it["id"].asString() in setOf("O1", "O2") })
            .allMatch { it["vehicleId"].asString() == "G2" }
    }

    @Test
    fun `restores schema two drafts exactly and preserves the saved operating date`() {
        var now = Instant.parse("2026-09-16T14:59:59Z").toEpochMilli()
        val plan = DispatchPlan(day(), "csv-a", { now })
        send(plan, objectNode("type" to "calculate_dispatch").apply { set("vehicleIds", strings("G1", "G2")) })
        val saved = plan.exportCheckpoint()

        now = Instant.parse("2026-09-16T15:00:00Z").toEpochMilli()
        val restored = DispatchPlan(day(), "csv-a", { now }, saved)
        assertThat(restored.snapshot().at("/dispatch/today").asString()).isEqualTo("2026-09-17")
        assertThat(restored.snapshot().at("/dispatch/readOnly").booleanValue()).isTrue()
        assertThat(restored.exportCheckpoint()).isEqualTo(saved)
        assertThatThrownBy { send(restored, objectNode("type" to "publish_dispatch", "draftVersion" to 1)) }
            .isInstanceOf(DispatchException::class.java)
            .extracting("code").isEqualTo("DATE_READ_ONLY")
    }

    @Test
    fun `rejects stale revisions unsupported demo commands and invalid checkpoints atomically`() {
        val plan = DispatchPlan(day(), "csv-a", { Instant.parse("2026-09-16T01:00:00Z").toEpochMilli() })
        val before = plan.exportCheckpoint()
        assertThatThrownBy { plan.command(objectNode("type" to "calculate_dispatch", "expectedRevision" to 9).apply { set("vehicleIds", strings("G1")) }) }
            .isInstanceOf(DispatchException::class.java).extracting("code").isEqualTo("REVISION_CONFLICT")
        assertThatThrownBy { send(plan, objectNode("type" to "arrive_stop")) }
            .isInstanceOf(DispatchException::class.java).extracting("code").isEqualTo("INVALID_COMMAND")
        assertThat(plan.exportCheckpoint()).isEqualTo(before)

        val invalid = copyObject(before).apply { put("sourceId", "csv-b") }
        assertThatThrownBy { DispatchPlan(day(), "csv-a", { 0 }, invalid) }
            .isInstanceOf(DispatchException::class.java).extracting("code").isEqualTo("INVALID_CHECKPOINT")
    }

    private fun publishedPlan(): DispatchPlan = DispatchPlan(
        day(),
        "csv-a",
        { Instant.parse("2026-09-16T01:00:00Z").toEpochMilli() },
    ).also { plan ->
        send(plan, objectNode("type" to "calculate_dispatch").apply { set("vehicleIds", strings("G1", "G2")) })
        send(plan, objectNode("type" to "publish_dispatch", "draftVersion" to 1))
    }

    private fun send(plan: DispatchPlan, command: ObjectNode): ObjectNode = plan.command(command.apply { put("expectedRevision", plan.revision) })

    private fun day(): ObjectNode = dispatchMapper.readTree(
        """
        {
          "schemaVersion":1,"date":"2026-09-16","summary":{"orders":4,"boxes":10},
          "groups":[
            {"id":"G1","label":"김기사","regionNames":["서울"]},
            {"id":"G2","label":"박기사","regionNames":["서울"]},
            {"id":"G3","label":"이기사","regionNames":["서울"]}
          ],
          "orders":[
            {"id":"O1","groupId":"G1","orderNumber":"O1","name":"한우상회","address":"서울 강남구 1","detailAddress":"","boxes":1,"sourceRows":1,"sequence":1,"coordinates":[127.001,37.5],"zoneIds":["Z1"]},
            {"id":"O2","groupId":"G2","orderNumber":"O2","name":" 한우상회 ","address":"서울 강남구 1","detailAddress":"","boxes":2,"sourceRows":2,"sequence":2,"coordinates":[127.002,37.5],"zoneIds":["Z1"]},
            {"id":"O3","groupId":"G1","orderNumber":"O3","name":"정육식당","address":"서울 송파구 2","detailAddress":"","boxes":3,"sourceRows":3,"sequence":3,"coordinates":[127.003,37.5],"zoneIds":["Z2"]},
            {"id":"O4","groupId":"G2","orderNumber":"O4","name":"미트마켓","address":"인천 남동구 3","detailAddress":"","boxes":4,"sourceRows":4,"sequence":4,"coordinates":[127.004,37.5],"zoneIds":["Z3"]}
          ]
        }
        """.trimIndent(),
    ) as ObjectNode

    private fun strings(vararg values: String) = dispatchMapper.createArrayNode().apply { values.forEach(::add) }

    private fun objectNode(vararg values: Pair<String, Any>): ObjectNode = dispatchMapper.createObjectNode().apply {
        values.forEach { (key, value) ->
            when (value) {
                is String -> put(key, value)
                is Int -> put(key, value)
                is Long -> put(key, value)
            }
        }
    }
}
