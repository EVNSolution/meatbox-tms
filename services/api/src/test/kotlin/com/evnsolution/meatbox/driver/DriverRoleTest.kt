package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.RoleFilter
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchSessionFilter
import com.evnsolution.meatbox.integrations.fcm.FcmSender
import com.evnsolution.meatbox.ops.quietAlerts
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.http.HttpMethod
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder
import org.springframework.web.filter.OncePerRequestFilter
import java.nio.file.Files
import java.nio.file.Path

/** A driver reaches the driver app for the vehicles assigned to them and for nothing else; operators for all. */
class DriverRoleTest {
    @TempDir lateinit var directory: Path
    private lateinit var mvc: MockMvc
    private lateinit var assignments: DriverAssignments

    /** The cookie `meatbox_session=<name>` is the user; the role comes from the name, as `RoleFilter` would set it. */
    private class TestRole : OncePerRequestFilter() {
        override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
            val name = request.getHeader("Cookie").orEmpty().substringAfter("meatbox_session=", "")
            val role = if (name.startsWith("boss")) "ops" else "driver"
            if (name.isNotEmpty()) request.setAttribute(RoleFilter.ROLE_ATTRIBUTE, role)
            chain.doFilter(request, response)
        }
    }

    @BeforeEach
    fun setup() {
        assignments = DriverAssignments(directory.resolve("driver-assignments.json"))
        assignments.assign(0, "G1", "kim")
        assignments.assign(1, "G2", "lee")
        val verifier = SessionVerifier { cookie ->
            cookie?.substringAfter("meatbox_session=", "")?.takeIf { it.isNotEmpty() } ?: throw LoginRequiredException()
        }
        val controller = DriverController(routeFixture(directory).driver, FcmSender("", ""), assignments, ORIGIN)
        mvc = MockMvcBuilders.standaloneSetup(controller)
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts()))
            .addFilters<StandaloneMockMvcBuilder>(TestRole(), DispatchSessionFilter(verifier)).build()
    }

    private fun call(
        user: String,
        builder: MockHttpServletRequestBuilder,
        body: String? = null,
    ): MockHttpServletResponse {
        builder.header("Cookie", "meatbox_session=$user").header("Origin", ORIGIN)
        if (body != null) builder.contentType("application/json").content(body)
        return mvc.perform(builder).andReturn().response
    }

    private fun get(user: String, path: String) = call(user, MockMvcRequestBuilders.get("$PATH$path"))

    private fun write(user: String, method: String, path: String, body: String) =
        call(user, MockMvcRequestBuilders.request(HttpMethod.valueOf(method), "$PATH$path"), body)

    private fun assertDenied(response: MockHttpServletResponse, code: String = "VEHICLE_NOT_ASSIGNED") {
        assertThat(response.status).isEqualTo(403)
        assertProblem(response.contentAsString, 403, code)
    }

    @Test
    fun `a driver reads the route, stops, history and messages of an assigned vehicle only`() {
        assertThat(get("kim", "/route?vehicleId=G1").status).isEqualTo(200)
        assertThat(get("kim", "/stops/O3?vehicleId=G1").status).isEqualTo(200)
        assertThat(get("kim", "/history?vehicleId=G1").status).isEqualTo(200)
        assertThat(get("kim", "/messages?vehicleId=G1").status).isEqualTo(200)
        val others = listOf("/route", "/stops/O3", "/history", "/messages").map { "$it?vehicleId=G2" }
        others.forEach { assertDenied(get("kim", it)) }
        assertDenied(write("kim", "POST", "/route/suggest?vehicleId=G2", "{}"))
        assertThat(write("kim", "POST", "/route/suggest?vehicleId=G1", "{}").status).isEqualTo(200)
    }

    @Test
    fun `a driver lists only their own vehicles and an unassigned driver none`() {
        fun ids(user: String) = driverJson.readTree(get(user, "/vehicles").contentAsString).path("vehicles").toList()
            .map { it.path("vehicleId").asString() }
        assertThat(ids("kim")).containsExactly("G1")
        assertThat(ids("lee")).containsExactly("G2")
        assertThat(ids("park")).isEmpty()
        assertThat(ids("boss")).containsExactlyInAnyOrder("G1", "G2")
    }

    @Test
    fun `a driver cannot write for a vehicle that is not theirs`() {
        val token = """{"vehicleId":"G2","token":"t","deviceId":"d","platform":"android"}"""
        assertDenied(write("kim", "PUT", "/push-token", token))
        assertThat(write("kim", "PUT", "/push-token", token.replace("G2", "G1")).status).isEqualTo(200)
        assertDenied(write("kim", "POST", "/messages", """{"vehicleId":"G2","from":"driver","body":"hi"}"""))
        assertThat(write("kim", "POST", "/messages", """{"vehicleId":"G1","from":"driver","body":"hi"}""").status)
            .isEqualTo(200)
        val samples = """[{"at":"2026-10-13T01:00:00Z","lat":37.5,"lng":127.0}]"""
        assertDenied(write("kim", "POST", "/locations", """{"vehicleId":"G2","samples":$samples}"""))
        assertDenied(write("kim", "POST", "/stops/O3/tip", """{"vehicleId":"G2","requestId":"r1","body":"x"}"""))
        val event = """{"eventId":"e1","type":"departed","occurredAt":"2026-10-13T01:00:00Z","date":"$DRIVER_DATE",
            "vehicleId":"G2","payload":{}}"""
        assertDenied(write("kim", "POST", "/events", event))
    }

    @Test
    fun `only an operator may write as the operator`() {
        val ops = """{"vehicleId":"G1","from":"ops","body":"hi"}"""
        assertDenied(write("kim", "POST", "/messages", ops), "ROLE_FORBIDDEN")
        assertThat(write("boss", "POST", "/messages", ops).status).isEqualTo(200)
    }

    @Test
    fun `an operator reaches every vehicle`() {
        assertThat(get("boss", "/route?vehicleId=G1").status).isEqualTo(200)
        assertThat(get("boss", "/route?vehicleId=G2").status).isEqualTo(200)
        assertThat(get("boss", "/history?vehicleId=G2").status).isEqualTo(200)
    }

    @Test
    fun `a push goes only to devices of accounts that may still drive the vehicle`() {
        val fixture = routeFixture(Files.createDirectory(directory.resolve("push")))
        var kimMayDrive = true
        val store = DriverStore(
            fixture.dispatch, fixture.state, isSessionActive = { _, _ -> true },
            mayDrive = { user, _ -> user != "kim" || kimMayDrive },
        )
        store.register(DRIVER_DATE, "kim", DRIVER_DIGEST, "G1", "kim-token", "kim-phone")
        store.register(DRIVER_DATE, "lee", DRIVER_DIGEST, "G1", "lee-token", "lee-phone")
        assertThat(store.tokens(DRIVER_DATE, "G1")).containsExactlyInAnyOrder("kim-token", "lee-token")
        kimMayDrive = false
        assertThat(store.tokens(DRIVER_DATE, "G1")).containsExactly("lee-token")
        assertThat(store.append(DRIVER_DATE, "G1", "ops", "hi").tokens).containsExactly("lee-token")
    }

    @Test
    fun `taking a vehicle away closes it at once and an unreadable file closes drivers, not operators`() {
        assertThat(get("kim", "/route?vehicleId=G1").status).isEqualTo(200)
        assignments.assign(2, "G1", null)
        assertDenied(get("kim", "/route?vehicleId=G1"))
        Files.writeString(directory.resolve("driver-assignments.json"), "{")
        val broken = get("kim", "/route?vehicleId=G1")
        assertThat(broken.status).isEqualTo(500)
        assertProblem(broken.contentAsString, 500, "DRIVER_ASSIGNMENTS_INVALID")
        assertThat(get("boss", "/route?vehicleId=G1").status).isEqualTo(200)
    }
}

private const val ORIGIN = "https://test.invalid"
private const val PATH = "/api/dispatch-data/days/$DRIVER_DATE/driver"
