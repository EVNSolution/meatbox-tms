package com.evnsolution.meatbox.ops

import org.slf4j.LoggerFactory

/** Default channel: one WARN line per alert. */
class LogAlertChannel : AlertChannel {
    override fun send(subject: String, body: String) {
        log.warn("ALERT {} | {}", subject, body.replace('\n', ' '))
    }

    private companion object { val log = LoggerFactory.getLogger("com.evnsolution.meatbox.ops.Alert") }
}
