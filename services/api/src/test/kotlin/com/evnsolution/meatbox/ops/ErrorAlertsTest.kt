package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

class ErrorAlertsTest {
    private val executor = alertExecutor()
    private val channel = RecordingChannel()
    private var clock = Instant.parse("2026-01-01T00:00:00Z")
    private val alerts = ErrorAlerts(channel, "host-1", executor) { clock }

    @Test
    fun `an unhandled exception and a failed save each send one alert without private data`() {
        val mvc = mvc(alerts)
        mvc.perform(get("/crash"))
        mvc.perform(get("/save"))
        mvc.perform(get("/conflict"))
        executor.drain()
        assertThat(channel.sent).hasSize(2)
        val (crashSubject, crashBody) = channel.sent[0]
        assertThat(crashSubject).contains("server", "INTERNAL_ERROR")
        assertThat(crashBody).contains("kind=server", "code=INTERNAL_ERROR", "at=2026-01-01T00:00:00Z", "server=host-1",
            "suppressed=0", "detail=IllegalStateException")
        assertThat(crashBody).doesNotContain("secret-path").doesNotContain("at com.")
        assertThat(channel.sent[1].first).contains("dispatch", "DISPATCH_STATE_WRITE_FAILED")
    }

    @Test
    fun `a failing channel never changes the 500 response`() {
        val failing = ErrorAlerts(RecordingChannel(IllegalStateException("channel down")), "h", executor)
        val response = mvc(failing).perform(get("/crash")).andReturn().response
        executor.drain()
        assertThat(response.status).isEqualTo(500)
        assertThat(response.contentType).startsWith("application/problem+json")
        assertProblem(response.contentAsString, 500, "INTERNAL_ERROR")
    }

    @Test
    fun `100 repeats in one window send once and the closing summary counts 99`() {
        repeat(100) { alerts.report("server", "INTERNAL_ERROR") }
        alerts.report("server", "OTHER_CODE")
        executor.drain()
        assertThat(channel.sent.map { it.first }).hasSize(2)
        assertThat(channel.sent[1].first).contains("OTHER_CODE")

        clock = clock.plus(ErrorAlerts.WINDOW).minusSeconds(1)
        alerts.flush()
        executor.drain()
        assertThat(channel.sent).hasSize(2)

        clock = clock.plusSeconds(1)
        alerts.flush()
        executor.drain()
        assertThat(channel.sent).hasSize(3)
        assertThat(channel.sent[2].first).contains("INTERNAL_ERROR", "summary")
        assertThat(channel.sent[2].second).contains("suppressed=99")

        alerts.flush()
        executor.drain()
        assertThat(channel.sent).hasSize(3)
        assertThat(alerts.recent().map { it.suppressedCount }).containsExactly(99, 0, 0)
    }

    @Test
    fun `a report after the window closed sends the summary then a fresh alert`() {
        repeat(3) { alerts.report("server", "INTERNAL_ERROR") }
        clock = clock.plus(ErrorAlerts.WINDOW)
        alerts.report("server", "INTERNAL_ERROR")
        executor.drain()
        assertThat(channel.sent.map { it.second.substringAfter("suppressed=").take(1) }).containsExactly("0", "2", "0")
    }

    @Test
    fun `drops alerts beyond the queue limit and counts them`() {
        val gate = java.util.concurrent.CountDownLatch(1)
        executor.execute { gate.await() }
        repeat(ErrorAlerts.MAX_QUEUE + 5) { alerts.report("k", "code-$it") }
        assertThat(alerts.droppedCount).isEqualTo(5)
        gate.countDown()
        executor.drain()
        assertThat(channel.sent).hasSize(ErrorAlerts.MAX_QUEUE)
    }

    @Test
    fun `keeps only the latest 50 alerts newest first`() {
        repeat(60) { alerts.report("k", "code-$it") }
        assertThat(alerts.recent()).hasSize(ErrorAlerts.MAX_RECENT)
        assertThat(alerts.recent().first().subject).contains("code-59")
    }

    private fun mvc(handlerAlerts: ErrorAlerts): MockMvc = MockMvcBuilders.standaloneSetup(Boom())
        .setControllerAdvice(ProblemExceptionHandler(handlerAlerts)).build()

    @RestController
    class Boom {
        @GetMapping("/crash")
        fun crash(): Unit = throw IllegalStateException("secret-path /var/data/x")

        @GetMapping("/save")
        fun save(): Unit = throw DispatchException(500, "DISPATCH_STATE_WRITE_FAILED", "State could not be saved.")

        @GetMapping("/conflict")
        fun conflict(): Unit = throw DispatchException(409, "REVISION_CONFLICT", "Reload and retry.")
    }
}
