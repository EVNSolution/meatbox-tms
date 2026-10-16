package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.ops.ErrorAlerts
import org.slf4j.LoggerFactory
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Once a minute, turns what the terminals sent since the last pass into outbox messages (contract 3.3: one message per
 * vehicle and sensor, no filler for gaps). Receiving never sends; the outbox sender does that later.
 */
class TemperatureBatcher(private val outbox: TemperatureOutbox, private val alerts: ErrorAlerts) : AutoCloseable {
    private val executor = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "meatbox-temperature-batcher").apply { isDaemon = true }
    }

    fun start(intervalSeconds: Long) {
        executor.scheduleWithFixedDelay(
            { runCatching(::tick).onFailure { log.warn("Temperature batch failed: {}", it.javaClass.simpleName) } },
            intervalSeconds, intervalSeconds, TimeUnit.SECONDS,
        )
    }

    /** One pass. Public so tests can drive it with their own clock. */
    fun tick() {
        outbox.collect().forEach { alerts.report("telemetry", "BATCH_FAILED", "vehicleId=$it") }
    }

    override fun close() {
        executor.shutdown()
    }

    private companion object { val log = LoggerFactory.getLogger("com.evnsolution.meatbox.telemetry.Batcher") }
}
