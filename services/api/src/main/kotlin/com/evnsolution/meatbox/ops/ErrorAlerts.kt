package com.evnsolution.meatbox.ops

import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

interface AlertChannel {
    fun send(subject: String, body: String)
}

data class AlertRecord(val subject: String, val at: Instant, val suppressedCount: Int)

/**
 * Single entry point for operator alerts. Same (kind, code) sends once per window; the rest are counted
 * and reported in one summary when the window closes (see [flush]).
 * Delivery runs on the given single-thread executor, so a slow channel never blocks a request.
 */
class ErrorAlerts(
    private val channel: AlertChannel,
    private val server: String,
    private val executor: ScheduledExecutorService,
    private val now: () -> Instant = Instant::now,
) {
    private class Window(val start: Instant, var sent: Int = 0, var suppressed: Int = 0)

    private val lock = Any()
    private val windows = HashMap<Pair<String, String>, Window>()
    private val recent = ArrayDeque<AlertRecord>()
    private val queued = AtomicInteger()
    private val dropped = AtomicLong()

    val channelKind: String get() = channel.javaClass.simpleName
    val droppedCount: Long get() = dropped.get()

    fun report(kind: String, code: String, detail: String? = null) {
        runCatching {
            synchronized(lock) {
                val at = now()
                val key = kind to code
                windows[key]?.takeIf { expired(it, at) }?.let { closeWindow(key, it, at) }
                val window = windows.getOrPut(key) { Window(at) }
                if (window.sent < SEND_PER_WINDOW) {
                    window.sent++
                    publish(kind, code, at, 0, detail, "")
                } else {
                    window.suppressed++
                }
            }
        }.onFailure { log.warn("Alert bookkeeping failed: {}", it.javaClass.simpleName) }
    }

    /** Closes expired windows and sends one summary for each that suppressed something. Called by a timer. */
    fun flush() {
        runCatching {
            synchronized(lock) {
                val at = now()
                windows.entries.filter { expired(it.value, at) }.forEach { closeWindow(it.key, it.value, at) }
            }
        }.onFailure { log.warn("Alert flush failed: {}", it.javaClass.simpleName) }
    }

    fun recent(): List<AlertRecord> = synchronized(lock) { recent.reversed() }

    private fun expired(window: Window, at: Instant) = !at.isBefore(window.start.plus(WINDOW))

    private fun closeWindow(key: Pair<String, String>, window: Window, at: Instant) {
        windows.remove(key)
        if (window.suppressed > 0) publish(key.first, key.second, at, window.suppressed, null, " (summary)")
    }

    private fun publish(kind: String, code: String, at: Instant, suppressed: Int, detail: String?, tag: String) {
        val subject = "[meatbox-tms] $kind $code$tag"
        val body = buildString {
            appendLine("kind=$kind")
            appendLine("code=$code")
            appendLine("at=$at")
            appendLine("server=$server")
            append("suppressed=$suppressed")
            detail?.let { append("\ndetail=").append(it.take(MAX_DETAIL).replace('\n', ' ')) }
        }
        recent.addLast(AlertRecord(subject, at, suppressed))
        if (recent.size > MAX_RECENT) recent.removeFirst()
        if (queued.incrementAndGet() > MAX_QUEUE) {
            queued.decrementAndGet()
            dropped.incrementAndGet()
            return
        }
        try {
            executor.execute {
                try {
                    channel.send(subject, body)
                } catch (@Suppress("TooGenericExceptionCaught") error: Exception) { // any channel failure
                    log.warn("Alert channel failed: {}", error.javaClass.simpleName)
                } finally {
                    queued.decrementAndGet()
                }
            }
        } catch (_: RejectedExecutionException) {
            queued.decrementAndGet()
            dropped.incrementAndGet()
        }
    }

    companion object {
        val WINDOW: Duration = Duration.ofMinutes(10)
        const val SEND_PER_WINDOW = 1
        const val MAX_QUEUE = 100
        const val MAX_RECENT = 50
        private const val MAX_DETAIL = 200
        private val log = LoggerFactory.getLogger("com.evnsolution.meatbox.ops.ErrorAlerts")
    }
}
