package com.evnsolution.meatbox.ops

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ScheduledThreadPoolExecutor

fun alertExecutor() = ScheduledThreadPoolExecutor(1) { task -> Thread(task).apply { isDaemon = true } }

fun quietAlerts() = ErrorAlerts(LogAlertChannel(), "test", alertExecutor())

/** Runs everything queued before this call; the executor has one thread and keeps FIFO order. */
fun ScheduledThreadPoolExecutor.drain() { submit {}.get() }

class RecordingChannel(private val failure: Throwable? = null) : AlertChannel {
    val sent = CopyOnWriteArrayList<Pair<String, String>>()
    override fun send(subject: String, body: String) {
        sent += subject to body
        failure?.let { throw it }
    }
}
