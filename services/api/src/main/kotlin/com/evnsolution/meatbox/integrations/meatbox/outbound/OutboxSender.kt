package com.evnsolution.meatbox.integrations.meatbox.outbound

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxItem
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxOutcome
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.telemetry.TemperatureOutbox
import org.slf4j.LoggerFactory
import java.io.IOException
import java.net.http.HttpTimeoutException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Sends the outbox messages that are due. A 2xx records `sentAt`. A 5xx, 429, timeout or refused connection retries
 * forever at the contract's intervals (5 s, 15 s, 45 s, 2 min, then every 5 min). Any other status is a rejection:
 * no retry, `failedAt` and one alert. After [UNREACHABLE_AFTER] failed attempts of one message, one more alert.
 */
class OutboxSender(
    private val store: DispatchStore,
    private val client: MeatboxClient,
    private val alerts: ErrorAlerts,
    private val clock: () -> Long = System::currentTimeMillis,
    private val telemetryOutbox: TemperatureOutbox? = null,
) : AutoCloseable {
    private val executor = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "meatbox-outbox").apply { isDaemon = true }
    }

    fun start(intervalSeconds: Long) {
        if (!client.enabled) {
            log.info("MEATBOX_API_BASE_URL is empty: outbox messages are kept but not sent")
            return
        }
        executor.scheduleWithFixedDelay(
            { runCatching(::tick).onFailure { log.warn("Outbox tick failed: {}", it.javaClass.simpleName) } },
            intervalSeconds, intervalSeconds, TimeUnit.SECONDS,
        )
    }

    /** One pass over everything due now. Public so tests can drive it with their own clock. */
    fun tick() {
        val due = store.dueOutbox(clock(), BATCH) + telemetryOutbox?.due(clock(), BATCH).orEmpty()
        due.forEach { item ->
            runCatching { deliver(item) }.onFailure { log.warn("Outbox record failed: {}", it.javaClass.simpleName) }
        }
    }

    private fun deliver(item: OutboxItem) {
        val (outcome, status) = attempt(item)
        val at = clock()
        val next = at + backoff(item.attempts + 1)
        // Temperature batches live in the telemetry files, not in a date checkpoint.
        val attempts = telemetryOutbox?.takeIf { item.kind == "temperature" }?.record(item, outcome, status, at, next)
            ?: store.recordOutbox(item, outcome, status, at, next)
        val code = item.kind.uppercase().replace('-', '_')
        when {
            outcome == OutboxOutcome.REJECTED ->
                alerts.report(KIND, "${code}_REJECTED", "messageId=${item.messageId} status=$status")
            outcome == OutboxOutcome.RETRY && attempts == UNREACHABLE_AFTER + 1 ->
                alerts.report(
                    KIND, "${code}_UNREACHABLE", "messageId=${item.messageId} attempts=$attempts last=$status",
                )
        }
    }

    private fun attempt(item: OutboxItem): Pair<OutboxOutcome, String> = try {
        val status = client.post(item)
        val outcome = when {
            status in SUCCESS -> OutboxOutcome.SENT
            status == TOO_MANY_REQUESTS || status >= SERVER_ERROR -> OutboxOutcome.RETRY
            else -> OutboxOutcome.REJECTED
        }
        outcome to status.toString()
    } catch (_: HttpTimeoutException) {
        OutboxOutcome.RETRY to "timeout"
    } catch (_: IOException) {
        OutboxOutcome.RETRY to "connect-failed"
    } catch (_: IllegalArgumentException) {
        OutboxOutcome.REJECTED to "invalid"
    }

    override fun close() {
        executor.shutdown()
    }

    companion object {
        const val KIND = "meatbox-outbound"
        const val UNREACHABLE_AFTER = 10
        private const val BATCH = 50
        private const val MILLIS = 1000
        private const val TOO_MANY_REQUESTS = 429
        private const val SERVER_ERROR = 500
        private val SUCCESS = 200..299
        private val STEPS_SECONDS = longArrayOf(5, 15, 45, 120, 300)
        private val log = LoggerFactory.getLogger("com.evnsolution.meatbox.integrations.meatbox.outbound.Outbox")

        /** Wait in millis after the [failures]-th failed attempt of one message. */
        fun backoff(failures: Int): Long = STEPS_SECONDS[minOf(failures, STEPS_SECONDS.size) - 1] * MILLIS
    }
}
