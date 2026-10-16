package com.evnsolution.meatbox.driver

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

/** The operator's operating dashboard over at most 31 days. Operators only (see `RoleFilter`). */
@RestController
@RequestMapping("/api/ops/dashboard")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DashboardController(private val dashboard: Dashboard) {
    @GetMapping
    fun range(@RequestParam from: String, @RequestParam to: String): ObjectNode = dashboard.range(from, to)
}
