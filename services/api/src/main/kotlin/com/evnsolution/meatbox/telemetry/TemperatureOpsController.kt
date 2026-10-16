package com.evnsolution.meatbox.telemetry

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

/** Under `/api/ops`, so the ops session filter already guards it. */
@RestController
@RequestMapping("/api/ops")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class TemperatureOpsController(private val outbox: TemperatureOutbox) {
    /** Unsent, rejected and sent temperature messages, in total and per vehicle. */
    @GetMapping("/telemetry")
    fun telemetry(): ObjectNode = outbox.summary()
}
