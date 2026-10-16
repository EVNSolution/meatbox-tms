package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus

import com.evnsolution.meatbox.compat.DispatchDataException
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.dispatch.DispatchException
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

@RestController
@RequestMapping("/api/dispatch-data/days/{date}/driver")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverController(
    private val store: DriverStore,
    private val sender: FcmSender,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    private val limits = mutableMapOf<String, Window>()

    @PutMapping("/push-token")
    fun register(@PathVariable date: String, request: HttpServletRequest): Map<String, Boolean> {
        val body = mutation(request, setOf("vehicleId", "token", "deviceId", "platform"))
        if (string(body, "platform", PLATFORM_LENGTH) != "android") {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_PLATFORM")
        }
        val session = AuthService.tokenFrom(request.getHeader("Cookie"))
            ?: driverFail(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")
        store.register(date, username(request), AuthService.digest(session), string(body, "vehicleId", ID_LENGTH),
            string(body, "token", TOKEN_LENGTH, false), string(body, "deviceId", ID_LENGTH, false))
        return mapOf("registered" to true)
    }

    @DeleteMapping("/push-token")
    fun unregister(@PathVariable date: String, request: HttpServletRequest): Map<String, Boolean> {
        val body = mutation(request, setOf("token"))
        store.unregister(date, username(request), string(body, "token", TOKEN_LENGTH, false))
        return mapOf("unregistered" to true)
    }

    @GetMapping("/messages")
    fun messages(@PathVariable date: String, @RequestParam vehicleId: String, request: HttpServletRequest): ObjectNode {
        limit(username(request), false)
        return store.messages(date, checked(vehicleId, ID_LENGTH))
    }

    @PostMapping("/messages")
    fun message(@PathVariable date: String, request: HttpServletRequest): ObjectNode {
        val body = mutation(request, setOf("vehicleId", "from", "body"))
        val from = string(body, "from", PLATFORM_LENGTH)
        if (from !in setOf("ops", "driver")) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_MESSAGE_FROM")
        val vehicleId = string(body, "vehicleId", ID_LENGTH)
        val pending = store.append(date, vehicleId, from, string(body, "body", MESSAGE_LENGTH))
        // Persist first. Push acceptance does not mean that the device displayed the notification.
        val delivery = if (from == "driver") PushSummary("not-requested") else
            sender.send(pending.tokens, date, body.path("vehicleId").asString(), pending.message.path("id").asString())
        return driverJson.createObjectNode().apply {
            set("message", pending.message)
            set("push", driverJson.valueToTree(delivery))
        }
    }

    private fun mutation(request: HttpServletRequest, fields: Set<String>): ObjectNode {
        if (request.getHeader("Origin") != origin) driverFail(HttpStatus.FORBIDDEN.value(), "ORIGIN_REQUIRED")
        limit(username(request), true)
        if (request.contentType?.substringBefore(';')?.trim()?.lowercase() != "application/json") {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_JSON")
        }
        val bytes = request.inputStream.readNBytes(MAX_BODY + 1)
        if (bytes.size > MAX_BODY) driverFail(HttpStatus.PAYLOAD_TOO_LARGE.value(), "DRIVER_BODY_TOO_LARGE")
        val body = runCatching { driverJson.readTree(bytes) as? ObjectNode }.getOrNull()
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_JSON")
        if (body.properties().map { it.key }.toSet() != fields) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        }
        return body
    }

    private fun username(request: HttpServletRequest): String =
        request.getAttribute("meatbox.username") as? String
            ?: driverFail(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")

    private fun string(body: ObjectNode, key: String, max: Int, allowSpace: Boolean = true): String {
        if (!body.path(key).isString) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        return checked(body.path(key).asString(), max, allowSpace)
    }

    private fun checked(value: String, max: Int, allowSpace: Boolean = true): String {
        val invalidLength = value.isBlank() || value.length > max
        val invalidSpace = value != value.trim() || (!allowSpace && value.any(Char::isWhitespace))
        val invalidControl = value.any { it.isISOControl() && it != '\n' }
        if (invalidLength || invalidSpace || invalidControl) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        }
        return value
    }

    @Synchronized
    private fun limit(username: String, write: Boolean) {
        val now = System.currentTimeMillis()
        limits.entries.removeIf { it.value.until <= now }
        val key = "$username:$write"
        if (key !in limits && limits.size >= MAX_USERS) {
            driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), "DRIVER_CAPACITY")
        }
        val window = limits.getOrPut(key) { Window(now + MINUTE_MILLIS) }
        val maximum = if (write) MAX_WRITES else MAX_READS
        if (++window.count > maximum) driverFail(HttpStatus.TOO_MANY_REQUESTS.value(), "DRIVER_RATE_LIMITED")
    }

    private data class Window(val until: Long, var count: Int = 0)

    companion object {
        private const val MAX_BODY = 8192
        private const val ID_LENGTH = 128
        private const val TOKEN_LENGTH = 4096
        private const val MESSAGE_LENGTH = 1000
        private const val PLATFORM_LENGTH = 16
        private const val MAX_USERS = 4096
        private const val MAX_WRITES = 30
        private const val MAX_READS = 120
        private const val MINUTE_MILLIS = 60_000L
    }
}
