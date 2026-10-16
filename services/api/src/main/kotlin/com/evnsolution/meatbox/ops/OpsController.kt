package com.evnsolution.meatbox.ops

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class AlertsView(val channel: String, val dropped: Long, val alerts: List<AlertRecord>)

@RestController
@RequestMapping("/api/ops")
class OpsController(private val alerts: ErrorAlerts) {
    @GetMapping("/alerts")
    fun alerts() = AlertsView(alerts.channelKind, alerts.droppedCount, alerts.recent())
}
