package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.eta.EtaPoint
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.Path

class DriverRouteSuggestTest {
    @TempDir lateinit var directory: Path

    // Stops in the current order: O1 (far), O3 (near), O4 (middle). The depot is at 127.00 on the same latitude.
    private val places = mapOf("O1" to "[127.20,37.5]", "O3" to "[127.01,37.5]", "O4" to "[127.10,37.5]")
    private val depot = EtaPoint(37.5, 127.0)

    private fun fixture(
        coordinates: Map<String, String> = places,
        addresses: Map<String, String> = emptyMap(),
        depot: EtaPoint? = this.depot,
    ) = routeFixture(directory, coordinates, addresses, depot)

    private fun RouteFixture.order(lockFirst: String? = null): List<String> =
        driver.queries.suggest(DRIVER_DATE, "G1", lockFirst).path("stopOrder").toList().map { it.asString() }

    @Test
    fun `proposes the nearest-first order from the depot with totals and the route revision`() {
        val f = fixture()
        val suggestion = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(suggestion.path("stopOrder").toList().map { it.asString() }).containsExactly("O3", "O4", "O1")
        assertThat(suggestion.path("changed").asBoolean()).isTrue()
        val revision = f.driver.queries.route(DRIVER_DATE, "G1").path("revision").asLong()
        assertThat(suggestion.path("revision").asLong()).isEqualTo(revision)
        // 0.2 degrees of longitude at 37.5 N is about 17.7 km straight, 24.8 km with the detour; two 5 minute stops.
        assertThat(suggestion.path("totalKm").asDouble()).isBetween(24.0, 26.0)
        assertThat(suggestion.path("totalMinutes").asInt()).isBetween(68, 72)
        assertThat(suggestion.path("placed").size()).isZero()
        assertThat(suggestion.path("vehicleId").asString()).isEqualTo("G1")
        assertThat(suggestion.path("date").asString()).isEqualTo(DRIVER_DATE)
    }

    @Test
    fun `changes nothing and answers the same twice`() {
        val f = fixture()
        val before = files(f)
        val snapshot = f.dispatch.snapshot(DRIVER_DATE).toString()
        val first = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        val second = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(second).isEqualTo(first)
        assertThat(f.dispatch.snapshot(DRIVER_DATE).toString()).isEqualTo(snapshot)
        assertThat(files(f)).isEqualTo(before)
    }

    @Test
    fun `the proposal applies as route_reordered and the route follows it`() {
        val f = fixture()
        val suggestion = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        val order = suggestion.path("stopOrder").toList().map { it.asString() }
        f.apply(suggestion)
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("stops").toList().map { it.path("stopId").asString() }).isEqualTo(order)
        // Applied, it is already the best order: the next proposal is the same and changes nothing.
        val again = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(again.path("stopOrder").toList().map { it.asString() }).isEqualTo(order)
        assertThat(again.path("changed").asBoolean()).isFalse()
    }

    @Test
    fun `without a depot the first stop stays first and the reported position is used`() {
        val f = fixture(depot = null)
        assertThat(f.order()).containsExactly("O1", "O4", "O3")
        val sample = """[{"at":"2026-10-13T09:00:00+09:00","lat":37.5,"lng":127.0}]"""
        f.driver.activity.acceptLocations(DRIVER_DATE, "G1", driverJson.readTree(sample) as ArrayNode)
        assertThat(f.order()).containsExactly("O3", "O4", "O1")
    }

    @Test
    fun `lockFirst makes that stop first and rejects stops that cannot be locked`() {
        val f = fixture(coordinates = places + ("O4" to "null"))
        assertThat(f.order(lockFirst = "O1")).first().isEqualTo("O1")
        assertThat(f.order(lockFirst = "O2")).first().isEqualTo("O1") // any order of the stop names the stop
        assertCode(400, "INVALID_INPUT") { f.order(lockFirst = "O4") } // no coordinates
        assertCode(404, "STOP_NOT_FOUND") { f.order(lockFirst = "nope") }
    }

    @Test
    fun `a stop without coordinates follows a similar address or goes last and is reported`() {
        val f = fixture(
            coordinates = places + ("O4" to "null"),
            addresses = mapOf(
                "O1" to "서울 강남구 테헤란로 1", "O2" to "서울 강남구 테헤란로 1", "O4" to "서울 강남구 테헤란로 99",
            ),
        )
        val suggestion = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(suggestion.path("stopOrder").toList().map { it.asString() }).containsExactly("O3", "O1", "O4")
        val placed = suggestion.path("placed").single()
        assertThat(placed.path("stopId").asString()).isEqualTo("O4")
        assertThat(placed.path("placed").asString()).isEqualTo("no-coordinates")
        assertThat(placed.path("afterStopId").asString()).isEqualTo("O1")
    }

    @Test
    fun `a stop without coordinates and no similar address goes last`() {
        val f = fixture(coordinates = places + ("O4" to "null"))
        val suggestion = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        assertThat(suggestion.path("stopOrder").toList().map { it.asString() }).containsExactly("O3", "O1", "O4")
        assertThat(suggestion.path("placed").single().path("afterStopId").isNull).isTrue()
    }

    @Test
    fun `after the departure only the pending stops move and the proposal applies`() {
        val f = fixture()
        f.driver.activity.acceptEvent(DRIVER_DATE, envelope("go", "departed", "{}"))
        val suggestion = f.driver.queries.suggest(DRIVER_DATE, "G1", null)
        val order = suggestion.path("stopOrder").toList().map { it.asString() }
        // O1 is current and holds its place; the truck is there, so the middle stop comes before the near one.
        assertThat(order).containsExactly("O1", "O4", "O3")
        f.apply(suggestion)
        val route = f.driver.queries.route(DRIVER_DATE, "G1")
        assertThat(route.path("stops").toList().map { it.path("stopId").asString() }).isEqualTo(order)
    }

    @Test
    fun `a finished route is locked and another vehicle has no proposal`() {
        val f = fixture()
        f.driver.activity.acceptEvent(DRIVER_DATE, envelope("go", "departed", "{}"))
        listOf("O1", "O3", "O4").forEach {
            f.driver.activity.acceptEvent(DRIVER_DATE, envelope("c-$it", "stop_completed", """{"stopId":"$it"}"""))
        }
        assertCode(409, "ROUTE_LOCKED") { f.order() }
        assertCode(404, "DRIVER_VEHICLE_NOT_FOUND") { f.driver.queries.suggest(DRIVER_DATE, "G9", null) }
        assertThat(f.driver.queries.suggest(DRIVER_DATE, "G2", null).path("stopOrder").size()).isZero()
    }

    /** Applies a proposal the way the app does: as a `route_reordered` event with the proposal's revision. */
    private fun RouteFixture.apply(suggestion: ObjectNode) {
        val order = driverJson.writeValueAsString(suggestion.path("stopOrder").toList().map { it.asString() })
        val payload = """{"stopOrder":$order,"expectedRevision":${suggestion.path("revision").asLong()}}"""
        driver.activity.acceptEvent(DRIVER_DATE, envelope("re", "route_reordered", payload))
    }

    private fun files(f: RouteFixture): Map<String, List<Byte>> = Files.list(f.state).use { stream ->
        stream.filter(Files::isRegularFile).toList()
            .associate { it.fileName.toString() to Files.readAllBytes(it).toList() }
    }

    private fun envelope(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:00:00+09:00",
        "date":"$DRIVER_DATE","vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode

    private fun assertCode(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }
}
