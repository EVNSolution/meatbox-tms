package com.evnsolution.meatbox.dispatch

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import tools.jackson.databind.node.ObjectNode

class OperationalStateTest {
    @Test
    fun `JSON numeric nodes use number semantics for schema and revision guards`() {
        val source = day().put("schemaVersion", 1.0)
        val state = OperationalState(source, "source-a", { 1_234L })
        val command = json(
            """{
              "type":"set_route_order","expectedRevision":0.0,"vehicleId":"G1",
              "order":["O2","O1","O1B"],
              "expectedOrder":["O1","O1B","O2"],
              "expectedStatuses":["pending","pending","pending"],"expectedPhase":"idle"
            }""",
        )

        assertThat(state.command(command).at("/state/revision").asLong()).isEqualTo(1L)
    }

    @Test
    fun `new operational state keeps imported content and emits presentation version zero`() {
        val state = OperationalState(day(), "source-a", { 1_234L })

        val snapshot = state.snapshot()
        assertThat(snapshot.at("/sourceData/date").asString()).isEqualTo("2026-09-16")
        assertThat(snapshot.at("/fleetDeliveries/0/customerRequests").isNull).isTrue()
        assertThat(snapshot.at("/fleetDeliveries/0/tip").isNull).isTrue()
        assertThat(snapshot.at("/fleetDeliveries/0/transportConditions").isNull).isTrue()
        assertThat(snapshot.at("/fleetVehicles/0/plate").asString()).isEqualTo("92나 2775")
        assertThat(snapshot.at("/fleetVehicles/0/location/coordinates/0").doubleValue()).isEqualTo(126.7655)
        assertThat(state.exportCheckpoint().get("presentationContentVersion").asInt()).isZero()
    }

    @Test
    fun `route order command is guarded and sparse checkpoint restores the same snapshot`() {
        var now = 1_234L
        val state = OperationalState(day(), "source-a", { now })
        val command = json(
            """{
              "type":"set_route_order","expectedRevision":0,"vehicleId":"G1",
              "order":["O2","O1","O1B"],
              "expectedOrder":["O1","O1B","O2"],
              "expectedStatuses":["pending","pending","pending"],"expectedPhase":"idle"
            }""",
        )

        val changed = state.command(command)
        assertThat(changed.at("/state/revision").asLong()).isEqualTo(1L)
        assertThat(changed.at("/state/fleetDeliveries/0/id").asString()).isEqualTo("O2")
        val checkpoint = state.exportCheckpoint()
        assertThat(checkpoint.at("/routes/G1")).isEqualTo(dispatchMapper.readTree("""["O2","O1","O1B"]"""))
        assertThat(checkpoint.get("orders").isEmpty).isTrue()
        assertThat(checkpoint.at("/events/0/message").isMissingNode).isTrue()

        now = 9_999L
        val restored = OperationalState(day(), "source-a", { now }, checkpoint)
        assertThat(restored.snapshot()).isEqualTo(state.snapshot())
        assertThatThrownBy {
            restored.command(command.deepCopy().put("expectedRevision", 0))
        }.isInstanceOfSatisfying(DispatchException::class.java) { error ->
            assertThat(error.status).isEqualTo(409)
        }
    }

    @Test
    fun `driver start arrive and complete move one destination bundle at a time and survive a checkpoint`() {
        var now = 1_000L
        val state = OperationalState(day(), "source-a", { now })
        fun run(body: String) = state.command(json(body.replace("REV", state.revision.toString())))

        assertThatThrownBy { run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1"}""") }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }

        val started = run("""{"type":"start_route","expectedRevision":REV,"vehicleId":"G1"}""")
        assertThat(started.at("/result/orderIds")).isEqualTo(dispatchMapper.readTree("""["O1","O1B"]"""))
        assertThat(started.at("/state/vehicleStates/G1/phase").asString()).isEqualTo("delivering")
        assertThat(started.at("/state/fleetDeliveries/0/status").asString()).isEqualTo("current")
        assertThat(started.at("/state/fleetDeliveries/1/status").asString()).isEqualTo("current")
        assertThatThrownBy { run("""{"type":"start_route","expectedRevision":REV,"vehicleId":"G1"}""") }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThatThrownBy {
            run("""{"type":"complete_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1"}""")
        }
            .describedAs("완료는 도착 뒤에만 된다")
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThatThrownBy { run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O2"}""") }
            .describedAs("다음 배송지는 도착 처리할 수 없다")
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }

        now = 2_000L
        val arrived = run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1B"}""")
        assertArrivedAtFirstStop(arrived)
        val savedArrival = state.exportCheckpoint()
        assertThat(savedArrival.at("/orders/O1/arrivedAt").asLong()).isEqualTo(now)
        assertThat(savedArrival.at("/orders/O1B/arrivedAt").asLong()).isEqualTo(now)
        assertThat(OperationalState(day(), "source-a", { now }, savedArrival).snapshot()).isEqualTo(state.snapshot())
        assertThatThrownBy { run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1"}""") }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThat(state.exportCheckpoint()).isEqualTo(savedArrival)

        now = 3_000L
        val completed = run("""{"type":"complete_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1"}""")
        assertThat(completed.at("/result/nextStopId").asString()).isEqualTo("O2")
        assertThat(completed.at("/state/fleetDeliveries/0/status").asString()).isEqualTo("done")
        assertThat(completed.at("/state/fleetDeliveries/2/status").asString()).isEqualTo("current")
        assertThat(completed.at("/state/vehicleStates/G1/kpi/stopsDone").asInt()).isEqualTo(2)
        assertThat(completed.at("/state/vehicleStates/G1/truck/fromId").asString()).isEqualTo("O1")
        assertThat(completed.at("/state/vehicleStates/G1/truck/toId").asString()).isEqualTo("O2")
        assertThat(completed.at("/state/vehicleStates/G1/truck/atStopId").isNull).isTrue()
        val savedCompletion = state.exportCheckpoint()
        assertThatThrownBy {
            run("""{"type":"complete_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1B"}""")
        }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThatThrownBy { run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O1"}""") }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThat(state.exportCheckpoint()).isEqualTo(savedCompletion)

        val restored = OperationalState(day(), "source-a", { now }, state.exportCheckpoint())
        assertThat(restored.snapshot()).isEqualTo(state.snapshot())

        run("""{"type":"arrive_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O2"}""")
        val finished = run("""{"type":"complete_stop","expectedRevision":REV,"vehicleId":"G1","orderId":"O2"}""")
        assertThat(finished.at("/result/nextStopId").isNull).isTrue()
        assertThat(finished.at("/state/vehicleStates/G1/phase").asString()).isEqualTo("done")
        assertThat(finished.at("/state/vehicleStates/G1/truck/dwelling").asBoolean()).isFalse()
        assertThat(finished.at("/state/vehicleStates/G1/truck/dwellRemaining").asInt()).isZero()
        assertThat(OperationalState(day(), "source-a", { now }, state.exportCheckpoint()).snapshot())
            .isEqualTo(state.snapshot())
    }

    @Test
    fun `arrival rejects a current bundle that is not the travelling target without changing the checkpoint`() {
        val state = OperationalState(day(), "source-a", { 1_000L })
        state.command(json("""{"type":"start_route","expectedRevision":0,"vehicleId":"G1"}"""))
        val checkpoint = state.exportCheckpoint()
        (checkpoint.at("/states/G1/truck") as ObjectNode).put("toId", "O2")
        val restored = OperationalState(day(), "source-a", { 1_000L }, checkpoint)
        val before = restored.exportCheckpoint()

        assertThatThrownBy {
            restored.command(json("""{"type":"arrive_stop","expectedRevision":1,"vehicleId":"G1","orderId":"O1"}"""))
        }.isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(409) }
        assertThat(restored.exportCheckpoint()).isEqualTo(before)
    }

    @Test
    fun `reassign moves a normalized destination bundle and preserves fractional boxes`() {
        val state = OperationalState(day(), "source-a", { 1_234L })
        val changed = state.command(
            json("""{"type":"reassign","expectedRevision":0,"orderIds":["O1B"],"targetVehicleId":"G2"}"""),
        )

        assertThat(changed.at("/result/changedCount").asInt()).isEqualTo(2)
        assertThat(changed.at("/result/changedBoxes").doubleValue()).isEqualTo(3.5)
        assertThat(changed.at("/state/fleetDeliveries/1/id").asString()).isEqualTo("O3")
        assertThat(changed.at("/state/fleetDeliveries/2/id").asString()).isEqualTo("O1")
        assertThat(changed.at("/state/fleetDeliveries/3/id").asString()).isEqualTo("O1B")
        assertThat(state.exportCheckpoint().get("orders").properties().map { it.key }.toSet())
            .isEqualTo(setOf("O1", "O1B"))
    }

    @Test
    fun `legacy checkpoint normalizes bundled status references and keeps presentation reads`() {
        val fleet = createDispatchFleet(day())
        val location = fleet.first()["location"]
        val checkpoint = json(
            """{
              "schemaVersion":1,"date":"2026-09-16","sourceId":"source-a","revision":2,
              "stateTimestamp":1234,"nextEventId":2,"nextNoticeId":2,
              "routes":{},"orders":{"O1B":{"status":"current","customerStage":"shipping"}},
              "states":{"G1":{"phase":"delivering","scenarioPreset":"shipping","scenarioStopId":"O1B",
                "truck":{"lat":37.5,"lng":127.0,"fromId":null,"toId":"O1B","atStopId":null,"dwelling":false,"dwellRemaining":0,"locationSource":"demo"},
                "vehicleLocation":${location}
              }},
              "events":[{"id":1,"ts":1234,"vehicleId":"G1","stopId":"O1B","action":"shipping","type":"stage"}],
              "notices":[{"id":1,"ts":1234,"stopId":"O1B","template":"shipping"}]
            }""",
        )

        val state = OperationalState(day(), "source-a", { 9_999L }, checkpoint)
        val snapshot = state.snapshot()
        assertThat(snapshot.at("/fleetDeliveries/0/status").asString()).isEqualTo("current")
        assertThat(snapshot.at("/fleetDeliveries/1/status").asString()).isEqualTo("current")
        assertThat(snapshot.at("/vehicleStates/G1/scenarioStopId").asString()).isEqualTo("O1")
        assertThat(snapshot.at("/vehicleStates/G1/truck/toId").asString()).isEqualTo("O1")
        assertThat(snapshot.at("/fleetDeliveries/0/timeline").size()).isEqualTo(1)
        assertThat(snapshot.at("/fleetDeliveries/1/notices").size()).isEqualTo(1)
        assertThat(snapshot.at("/fleetDeliveries/0/customerRequests/source").asString()).isEqualTo("presentation")
        assertThat(state.exportCheckpoint().get("presentationContentVersion").asInt()).isEqualTo(1)

        assertThatThrownBy {
            state.command(json("""{"type":"reassign","expectedRevision":2,"orderIds":["O1"],"targetVehicleId":"G2"}"""))
        }.isInstanceOfSatisfying(DispatchException::class.java) { error ->
            assertThat(error.status).isEqualTo(400)
        }
    }

    private fun day(): ObjectNode = json(
        """{
          "schemaVersion":1,"date":"2026-09-16","summary":{"orders":4,"boxes":10},
          "groups":[
            {"id":"G1","label":"기사 1","regionNames":["서울"]},
            {"id":"G2","label":"기사 2","regionNames":["경기"]}
          ],
          "orders":[
            {"id":"O1","groupId":"G1","orderNumber":"O1","name":"같은 곳","address":"서울 1","detailAddress":"","boxes":1,"sourceRows":1,"sequence":1,"coordinates":[127,37.5],"zoneIds":["Z1"]},
            {"id":"O1B","groupId":"G1","orderNumber":"O1B","name":"같은 곳 ","address":" 서울 1 ","detailAddress":"","boxes":2.5,"sourceRows":1,"sequence":2,"coordinates":[127,37.5],"zoneIds":["Z1"]},
            {"id":"O2","groupId":"G1","orderNumber":"O2","name":"다른 곳","address":"서울 2","detailAddress":"","boxes":3,"sourceRows":1,"sequence":3,"coordinates":[127.1,37.6],"zoneIds":["Z1"]},
            {"id":"O3","groupId":"G2","orderNumber":"O3","name":"옮길 곳","address":"경기 1","detailAddress":"","boxes":3.5,"sourceRows":1,"sequence":1,"coordinates":[127.2,37.7],"zoneIds":["Z1"]}
          ]
        }""",
    )

    private fun assertArrivedAtFirstStop(response: ObjectNode) {
        val truck = response.at("/state/vehicleStates/G1/truck")
        assertThat(truck.path("dwelling").asBoolean()).isTrue()
        assertThat(truck.path("toId").isNull).isTrue()
        assertThat(truck.path("fromId").asString()).isEqualTo("O1")
        assertThat(truck.path("atStopId").asString()).isEqualTo("O1")
        assertThat(response.at("/state/fleetDeliveries/0/customerStatus/key").asString()).isEqualTo("arrived")
    }

    private fun json(value: String): ObjectNode = dispatchMapper.readTree(value) as ObjectNode
}
