package com.evnsolution.meatbox.driver

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

/** The operator's list of what drivers noted at stops on one day. Operators only (see `RoleFilter`). */
@RestController
@RequestMapping("/api/ops/driver-notes")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverNotesController(private val store: DriverStore) {
    @GetMapping
    fun list(@RequestParam date: String): ObjectNode = store.queries.notes(date)
}
