package com.evnsolution.meatbox.outbound

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.routeFixture
import com.evnsolution.meatbox.ops.OpsController
import com.evnsolution.meatbox.ops.OpsSessionFilter
import com.evnsolution.meatbox.ops.quietAlerts
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.support.DefaultListableBeanFactory
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.nio.file.Path

class OpsOutboxTest {
    @TempDir lateinit var directory: Path

    private fun outbox(date: String) = get("/api/ops/outbox").param("date", date)

    private fun <T : Any> provider(type: Class<T>, bean: T): ObjectProvider<T> =
        DefaultListableBeanFactory().apply { registerSingleton("bean", bean) }.getBeanProvider(type)

    @Test
    fun `needs a session and shows counts and the newest messages without bodies`() {
        val f = routeFixture(directory)
        val verifier = SessionVerifier { cookie ->
            if (cookie == "session=valid") "ops" else throw LoginRequiredException()
        }
        val controller = OpsController(quietAlerts(), provider(DispatchStore::class.java, f.dispatch))
        val mvc = MockMvcBuilders.standaloneSetup(controller)
            .addFilters<org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder>(
                OpsSessionFilter(provider(SessionVerifier::class.java, verifier)),
            )
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts())).build()

        val denied = mvc.perform(outbox(DRIVER_DATE)).andReturn().response
        assertThat(denied.status).isEqualTo(401)
        assertProblem(denied.contentAsString, 401, "LOGIN_REQUIRED")

        val ok = mvc.perform(outbox(DRIVER_DATE).header("Cookie", "session=valid")).andReturn().response
        assertThat(ok.status).isEqualTo(200)
        val json = driverJson.readTree(ok.contentAsString)
        assertThat(json.path("pending").asInt()).isEqualTo(4)
        assertThat(json.path("failed").asInt()).isZero()
        assertThat(json.path("sent").asInt()).isZero()
        val first = json.path("recent").first()
        assertThat(first.path("kind").asString()).isEqualTo("delivery-status")
        assertThat(first.path("attempts").asInt()).isZero()
        assertThat(first.path("nextAttemptAt").asString()).isNotBlank()
        assertThat(first.has("body")).isFalse()
        assertThat(ok.contentAsString).doesNotContain("MB-").doesNotContain("Bearer")

        val invalid = mvc.perform(outbox("2026-13-40").header("Cookie", "session=valid")).andReturn().response
        assertProblem(invalid.contentAsString, 400, "INVALID_DATE")
    }
}
