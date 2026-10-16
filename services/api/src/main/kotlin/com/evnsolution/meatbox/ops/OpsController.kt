package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.DispatchStore
import org.springframework.beans.factory.ObjectProvider
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode
import java.time.LocalDate

data class AlertsView(val channel: String, val dropped: Long, val alerts: List<AlertRecord>)

@RestController
@RequestMapping("/api/ops")
class OpsController(private val alerts: ErrorAlerts, private val dispatch: ObjectProvider<DispatchStore>) {
    @GetMapping("/alerts")
    fun alerts() = AlertsView(alerts.channelKind, alerts.droppedCount, alerts.recent())

    /** Counts of unsent, rejected and sent Meatbox messages of one date, and the newest 20 without their bodies. */
    @GetMapping("/outbox")
    fun outbox(@RequestParam date: String): ObjectNode {
        val store = dispatch.ifAvailable
            ?: throw DispatchException(UNAVAILABLE, "OUTBOX_UNAVAILABLE", "OUTBOX_UNAVAILABLE")
        val valid = runCatching { LocalDate.parse(date).toString() == date }.getOrDefault(false)
        if (!valid) throw DispatchException(BAD_REQUEST, "INVALID_DATE", "INVALID_DATE")
        return store.outboxSummary(date, RECENT)
    }

    private companion object {
        const val RECENT = 20
        const val UNAVAILABLE = 503
        const val BAD_REQUEST = 400
    }
}
