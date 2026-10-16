package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.auth.DriverAccount
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

/** The operator's driver master (region, skill, contact, address, contract, vehicle, Capa). Operators only. */
@RestController
@RequestMapping("/api/ops/driver-profiles")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverProfilesController(
    private val profiles: DriverProfiles,
    private val auth: ObjectProvider<AuthService>,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    /** Every driver account with its profile (or nulls), then profiles whose account is gone, marked `known: false`. */
    @GetMapping
    fun list(): ObjectNode {
        val view = profiles.view()
        val accounts = drivers().associateBy { it.username }
        return driverJson.createObjectNode().apply {
            put("revision", view.revision)
            putArray("drivers").also { rows ->
                accounts.values.sortedBy { it.username }
                    .forEach { rows.add(row(it.username, it, view.profiles[it.username])) }
                view.profiles.keys.filter { it !in accounts }.sorted()
                    .forEach { rows.add(row(it, null, view.profiles[it])) }
            }
        }
    }

    /** Body `{revision, profile}`; a null `profile` removes the driver's profile. */
    @PutMapping("/{username}")
    fun save(@PathVariable username: String, request: HttpServletRequest): ObjectNode {
        if (origin.isEmpty() || request.getHeader("Origin") != origin) {
            driverFail(HttpStatus.FORBIDDEN.value(), "ORIGIN_REQUIRED")
        }
        val name = driverText(username, NAME_LENGTH, false)
        val body = runCatching { driverJson.readTree(request.inputStream.readNBytes(MAX_BODY + 1)) as? ObjectNode }
            .getOrNull()?.takeIf { it.size() == 2 && it.has("revision") && it.has("profile") }
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        val revision = body.path("revision").takeIf { it.isIntegralNumber && it.asLong() >= 0 }?.asLong()
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        val profile = body.path("profile")
        if (!profile.isNull && drivers().none { it.username == name }) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "DRIVER_NOT_FOUND")
        }
        if (profile.isNull && !profiles.view().profiles.containsKey(name)) {
            driverFail(HttpStatus.NOT_FOUND.value(), "PROFILE_NOT_FOUND")
        }
        val view = profiles.put(revision, name, profile)
        // The log names the driver and the operator, never the contents: a profile holds contact data.
        log.info(
            "Changed driver profile: driver={} removed={} revision={} by={}",
            name, profile.isNull, view.revision, request.getAttribute("meatbox.ops.user") ?: "unknown",
        )
        return driverJson.createObjectNode().put("revision", view.revision).put("username", name)
    }

    private fun row(username: String, account: DriverAccount?, profile: ObjectNode?): ObjectNode =
        driverJson.createObjectNode().apply {
            put("username", username).put("displayName", account?.displayName ?: username)
            put("known", account != null).put("disabled", account?.disabled ?: true)
            PROFILE_TEXT_LIMITS.keys.forEach { key ->
                val text = profile?.path(key)?.takeIf { it.isString }
                if (text != null) put(key, text.asString()) else putNull(key)
            }
            putObject("capa").apply {
                val capa = profile?.path("capa")
                listOf("stops", "boxes", "weightKg").forEach { key ->
                    val number = capa?.path(key)?.takeIf { it.isNumber }
                    if (number != null) set(key, number.deepCopy()) else putNull(key)
                }
            }
        }

    private fun drivers(): List<DriverAccount> = auth.ifAvailable?.driverAccounts().orEmpty()

    private companion object {
        val log = LoggerFactory.getLogger(DriverProfilesController::class.java)
        const val NAME_LENGTH = 128
        const val MAX_BODY = 8192
    }
}
