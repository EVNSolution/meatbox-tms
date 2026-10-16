package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.writeAtomically
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

internal val PROFILE_TEXT_LIMITS = linkedMapOf(
    "region" to 100, "skill" to 50, "phone" to 50, "address" to 300, "contract" to 300, "vehicleType" to 100,
    "topSpec" to 200,
)
private val CAPA_LIMITS = linkedMapOf("stops" to 10_000.0, "boxes" to 100_000.0, "weightKg" to 100_000.0)

/**
 * The driver master: per driver account the operator's register of region, skill, contact, address, contract,
 * vehicle type, top spec and the largest load (Capa: stops, boxes, weight), as `{version, revision, profiles}` in one
 * file of the state directory. A profile holds personal data, so the file is for operators only and goes into the
 * data export. Like [DriverAssignments] the file is read on every call and an unreadable one fails closed.
 */
class DriverProfiles(private val file: Path) {
    class View(val revision: Long, val profiles: Map<String, ObjectNode>)

    @Synchronized
    fun view(): View {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return View(0, emptyMap())
        val root = runCatching {
            if (Files.size(file) > MAX_BYTES) invalid()
            driverJson.readTree(Files.readAllBytes(file)) as? ObjectNode
        }.getOrNull() ?: invalid()
        val entries = root.path("profiles")
        if (root.path("version").asInt() != VERSION || !root.path("revision").isIntegralNumber || !entries.isObject) {
            invalid()
        }
        val map = LinkedHashMap<String, ObjectNode>()
        entries.properties().forEach { (username, profile) ->
            map[username] = profile as? ObjectNode ?: invalid()
        }
        return View(root.path("revision").asLong(), map)
    }

    /** Sets the cleaned [profile] of [username], or removes it with null. [revision] must be the last one read. */
    @Synchronized
    fun put(revision: Long, username: String, profile: JsonNode?): View {
        val current = view()
        if (current.revision != revision) driverFail(HttpStatus.CONFLICT.value(), "PROFILE_REVISION_CONFLICT")
        val next = LinkedHashMap(current.profiles)
        if (profile == null || profile.isNull) next.remove(username) else next[username] = clean(profile)
        if (next.size > MAX_PROFILES) driverFail(HttpStatus.BAD_REQUEST.value(), "TOO_MANY_PROFILES")
        val root = driverJson.createObjectNode().put("version", VERSION).put("revision", revision + 1)
        root.putObject("profiles").apply { next.toSortedMap().forEach { (name, value) -> set(name, value) } }
        try {
            writeAtomically(file, driverJson.writeValueAsBytes(root))
        } catch (_: IOException) {
            driverFail(HttpStatus.INTERNAL_SERVER_ERROR.value(), "DRIVER_PROFILES_WRITE_FAILED")
        }
        return View(revision + 1, next)
    }

    /** Only the known fields; a blank text or null number means "not set" and is left out. Anything else is refused. */
    private fun clean(profile: JsonNode): ObjectNode {
        val body = profile as? ObjectNode ?: invalidInput()
        val capa = body.path("capa")
        if (body.properties().any { it.key !in PROFILE_TEXT_LIMITS && it.key != "capa" }) invalidInput()
        if (body.has("capa") && !capa.isObject && !capa.isNull) invalidInput()
        val out = driverJson.createObjectNode()
        PROFILE_TEXT_LIMITS.forEach { (key, max) -> cleanText(body.path(key), max)?.let { out.put(key, it) } }
        val limits = cleanCapa(capa)
        if (limits.size() > 0) out.set("capa", limits)
        return out
    }

    private fun cleanText(value: JsonNode, max: Int): String? {
        if (value.isNull || value.isMissingNode) return null
        if (!value.isString) invalidInput()
        return value.asString().takeIf { it.isNotBlank() }?.let { driverText(it.trim(), max) }
    }

    private fun cleanCapa(capa: JsonNode): ObjectNode {
        val limits = driverJson.createObjectNode()
        capa.properties().forEach { if (it.key !in CAPA_LIMITS) invalidInput() }
        CAPA_LIMITS.forEach { (key, max) ->
            val value = capa.path(key)
            if (value.isNull || value.isMissingNode) return@forEach
            if (!value.isNumber || value.asDouble() < 0 || value.asDouble() > max) invalidInput()
            if (key == "stops" && !value.isIntegralNumber) invalidInput()
            if (key == "stops") limits.put(key, value.asLong()) else limits.put(key, round3(value.asDouble()))
        }
        return limits
    }

    private fun round3(value: Double): Double = Math.round(value * MILLI) / MILLI

    private fun invalid(): Nothing = driverFail(HttpStatus.INTERNAL_SERVER_ERROR.value(), "DRIVER_PROFILES_INVALID")

    private companion object {
        const val VERSION = 1
        const val MAX_BYTES = 4L * 1024 * 1024
        const val MAX_PROFILES = 5_000
        const val MILLI = 1000.0
    }
}
