package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.integrations.fcm.FcmSender
import com.evnsolution.meatbox.ops.quietAlerts
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchSessionFilter
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.nio.file.Path

class DriverHttpTest {
    @TempDir lateinit var directory: Path
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setup() {
        val (store) = driverFixture(directory)
        val filter = DispatchSessionFilter(SessionVerifier { cookie ->
            if (cookie != "meatbox_session=fixture") throw LoginRequiredException()
            "demo"
        })
        val assignments = DriverAssignments(directory.resolve("assign.json"))
        mvc = MockMvcBuilders.standaloneSetup(DriverController(store, FcmSender("", ""), assignments, ORIGIN))
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts()))
            .addFilters<org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder>(filter).build()
    }

    @Test
    fun `protects all driver routes and mutations with existing session and origin`() {
        val anonymous = mvc.perform(MockMvcRequestBuilders.get(PATH + "/messages?vehicleId=G1")).andReturn().response
        assertThat(anonymous.status).isEqualTo(401)
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
        assertThat(anonymous.contentType).startsWith("application/problem+json")
        assertThat(anonymous.getHeader("Cache-Control")).isEqualTo("no-store")
        assertThat(anonymous.getHeader("X-Meatbox-Dispatch-Owner")).isEqualTo("kotlin")
        val missingOrigin = mvc.perform(MockMvcRequestBuilders.post(PATH + "/messages")
            .header("Cookie", "meatbox_session=fixture").contentType("application/json").content(MESSAGE))
            .andReturn().response
        assertThat(missingOrigin.status).isEqualTo(403)
        assertProblem(missingOrigin.contentAsString, 403, "ORIGIN_REQUIRED")
        val response = post(MESSAGE)
        assertThat(response.status).isEqualTo(200)
        assertThat(driverJson.readTree(response.contentAsString).path("push").path("status").asString())
            .isEqualTo("unconfigured")
        val reply = post(MESSAGE.replace("\"ops\"", "\"driver\""))
        assertThat(driverJson.readTree(reply.contentAsString).path("push").path("status").asString())
            .isEqualTo("not-requested")
    }

    @Test
    fun `rejects malformed duplicate oversized and unexpected fields before mutation`() {
        val bodies = listOf("{", "[]", MESSAGE + "{}", MESSAGE.replace("\"body\":", "\"body\":\"duplicate\",\"body\":"),
            MESSAGE.replace("\"hi\"", "true"), MESSAGE.dropLast(1) + ",\"extra\":true}")
        bodies.forEach { assertThat(post(it).status).isEqualTo(400) }
        assertThat(post(" ".repeat(8193)).status).isEqualTo(413)
        assertThat(post(MESSAGE.replace("hi", "x".repeat(1001))).status).isEqualTo(400)
        assertThat(post(MESSAGE.replace("G1", "unknown")).status).isEqualTo(404)
    }

    @Test
    fun `rate limits writes and does not expose registration token`() {
        val response = mvc.perform(MockMvcRequestBuilders.put(PATH + "/push-token")
            .header("Cookie", "meatbox_session=fixture").header("Origin", ORIGIN).contentType("application/json")
            .content("""{"vehicleId":"G1","token":"secret","deviceId":"fixture","platform":"android"}"""))
            .andReturn().response
        assertThat(response.status).isEqualTo(200)
        assertThat(response.contentAsString).doesNotContain("secret")
        repeat(29) { assertThat(post(MESSAGE).status).isEqualTo(200) }
        val limited = post(MESSAGE)
        assertThat(limited.status).isEqualTo(429)
        assertThat(limited.getHeader("Retry-After")).isEqualTo("60")
        assertProblem(limited.contentAsString, 429, "DRIVER_RATE_LIMITED")
    }

    private fun post(body: String) = mvc.perform(MockMvcRequestBuilders.post(PATH + "/messages")
        .header("Cookie", "meatbox_session=fixture").header("Origin", ORIGIN)
        .contentType("application/json").content(body)).andReturn().response

    companion object {
        private const val ORIGIN = "https://test.invalid"
        private const val PATH = "/api/dispatch-data/days/$DRIVER_DATE/driver"
        private const val MESSAGE = """{"vehicleId":"G1","from":"ops","body":"hi"}"""
    }
}
