package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.DispatchStore
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode
import java.time.LocalDate

data class AlertsView(val channel: String, val dropped: Long, val alerts: List<AlertRecord>)

@RestController
@RequestMapping("/api/ops")
class OpsController(
    private val alerts: ErrorAlerts,
    private val dispatch: ObjectProvider<DispatchStore>,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
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

    /**
     * The operator's answer to a date whose prepared source changed under its saved plan. `keep-checkpoint` binds the
     * plan to the new source, `discard-checkpoint` moves it aside as a backup. Neither is ever chosen automatically.
     */
    @PostMapping("/days/{date}/source-conflict/resolve")
    fun resolveSourceConflict(
        @PathVariable date: String,
        @RequestBody body: ResolveRequest,
        request: HttpServletRequest,
    ): ObjectNode {
        if (origin.isEmpty() || request.getHeader("Origin") != origin) reject(FORBIDDEN, "ORIGIN_REQUIRED")
        val store = dispatch.ifAvailable ?: reject(UNAVAILABLE, "DISPATCH_UNAVAILABLE")
        val valid = runCatching { LocalDate.parse(date).toString() == date }.getOrDefault(false)
        if (!valid) reject(BAD_REQUEST, "INVALID_DATE")
        val user = request.getAttribute(OpsSessionFilter.USER_ATTRIBUTE)?.toString() ?: "unknown"
        return store.resolveSourceConflict(date, body.action.orEmpty(), user)
    }

    data class ResolveRequest(val action: String?)

    private fun reject(status: Int, code: String): Nothing = throw DispatchException(status, code, code)

    private companion object {
        const val FORBIDDEN = 403
        const val RECENT = 20
        const val UNAVAILABLE = 503
        const val BAD_REQUEST = 400
    }
}
