package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Path

class DriverTipTest {
    @TempDir lateinit var directory: Path

    private fun RouteFixture.tip(stopId: String, requestId: String, text: String, vehicleId: String = "G1") =
        driver.activity.setTip(DRIVER_DATE, vehicleId, stopId, requestId, text)

    private fun RouteFixture.tips(stopId: String): List<String> =
        driver.queries.stop(DRIVER_DATE, "G1", stopId).path("orders").toList()
            .map { it.path("tip").path("body").asString() }

    private fun assertCode(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun event(id: String, type: String, payload: String): ObjectNode = driverJson.readTree(
        """{"eventId":"$id","type":"$type","occurredAt":"2026-10-13T10:00:00+09:00","date":"$DRIVER_DATE",
        "vehicleId":"G1","payload":$payload}""",
    ) as ObjectNode

    @Test
    fun `writes the tip on every order of the bundle with the driver as author`() {
        val f = routeFixture(directory)
        val reply = f.tip("O2", "tip-1", "  뒷문 이용\r\n벨 없음  ")
        assertThat(reply.body.path("stopId").asString()).isEqualTo("O1")
        assertThat(reply.body.path("tip").path("body").asString()).isEqualTo("뒷문 이용\n벨 없음")
        assertThat(reply.body.path("tip").path("author").asString()).isEqualTo("합성 기사")
        assertThat(reply.body.path("tip").path("updatedAt").isString).isTrue()
        assertThat(reply.duplicate).isFalse()
        assertThat(f.tips("O1")).containsExactly("뒷문 이용\n벨 없음", "뒷문 이용\n벨 없음")
        assertThat(f.tips("O3").single()).isNotEqualTo("뒷문 이용\n벨 없음")
    }

    @Test
    fun `a resend answers from the stored result and a different tip under the same request is refused`() {
        val f = routeFixture(directory)
        f.tip("O1", "tip-1", "첫 팁")
        val revision = f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()
        val again = f.tip("O1", "tip-1", "첫 팁")
        assertThat(again.duplicate).isTrue()
        assertThat(f.dispatch.snapshot(DRIVER_DATE).path("revision").asLong()).isEqualTo(revision)
        assertCode(409, "REQUEST_ID_MISMATCH") { f.tip("O1", "tip-1", "다른 팁") }
        assertCode(400, "INVALID_OPERATION") { f.tip("O1", "tip-2", "첫 팁") }
        assertThat(f.tip("O1", "tip-3", "고친 팁").body.path("tip").path("body").asString()).isEqualTo("고친 팁")
    }

    @Test
    fun `refuses empty, long, markup and control text and stops that are not on the vehicle`() {
        val f = routeFixture(directory)
        assertCode(400, "INVALID_OPERATION") { f.tip("O1", "a", "   ") }
        assertCode(400, "INVALID_OPERATION") { f.tip("O1", "b", "x".repeat(501)) }
        assertCode(400, "INVALID_OPERATION") { f.tip("O1", "c", "<b>굵게</b>") }
        assertCode(400, "INVALID_OPERATION") { f.tip("O1", "d", "끊김\u0001") }
        assertThat(f.tip("O1", "e", "가".repeat(500)).body.path("tip").path("body").asString()).hasSize(500)
        assertCode(404, "STOP_NOT_FOUND") { f.tip("nope", "g", "팁") }
        assertCode(404, "DRIVER_VEHICLE_NOT_FOUND") { f.tip("O1", "h", "팁", vehicleId = "G9") }
        assertCode(404, "STOP_NOT_FOUND") { f.tip("O1", "i", "팁", vehicleId = "G2") }
        assertCode(400, "INVALID_COMMAND") { f.tip("O1", "bad id", "팁") }
    }

    @Test
    fun `a closed stop keeps its tip, while a waiting stop can still be changed after the departure`() {
        val f = routeFixture(directory)
        f.tip("O3", "before", "출발 전 팁")
        f.driver.activity.acceptEvent(DRIVER_DATE, event("go", "departed", "{}"))
        f.driver.activity.acceptEvent(DRIVER_DATE, event("done", "stop_completed", """{"stopId":"O1"}"""))
        assertCode(409, "OPERATION_REVISION_CONFLICT") { f.tip("O1", "late", "늦은 팁") }
        assertThat(f.tip("O3", "after", "출발 후 팁").body.path("tip").path("body").asString()).isEqualTo("출발 후 팁")
    }

    @Test
    fun `the tip survives a restart`() {
        val f = routeFixture(directory)
        f.tip("O1", "tip-1", "재시작 뒤에도")
        val restarted = f.restarted()
        assertThat(restarted.tips("O1")).containsExactly("재시작 뒤에도", "재시작 뒤에도")
        assertThat(restarted.tip("O1", "tip-1", "재시작 뒤에도").duplicate).isTrue()
    }
}
