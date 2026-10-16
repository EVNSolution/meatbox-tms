package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.writeAtomically
import org.springframework.http.HttpStatus
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import tools.jackson.databind.node.ObjectNode

/**
 * Which driver account drives which vehicle: `{version, revision, assignments: {vehicleId: username}}` in one file of
 * the state directory. One driver per vehicle; a driver may have several vehicles. A date has no say: the assignment
 * is standing. The file is small and read on every call, so a slot switch never serves a stale answer. A missing
 * file is no assignment at all, and an unreadable one fails the driver's requests rather than opening them.
 */
class DriverAssignments(private val file: Path) {
    class View(val revision: Long, val assignments: Map<String, String>)

    @Synchronized
    fun view(): View {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return View(0, emptyMap())
        val root = runCatching {
            if (Files.size(file) > MAX_BYTES) invalid()
            driverJson.readTree(Files.readAllBytes(file)) as? ObjectNode
        }.getOrNull() ?: invalid()
        val entries = root.path("assignments")
        if (root.path("version").asInt() != VERSION || !root.path("revision").isIntegralNumber || !entries.isObject) {
            invalid()
        }
        val map = LinkedHashMap<String, String>()
        entries.properties().forEach { (vehicle, driver) ->
            if (!driver.isString) invalid()
            map[vehicle] = driver.asString()
        }
        return View(root.path("revision").asLong(), map)
    }

    fun driverOf(vehicleId: String): String? = view().assignments[vehicleId]

    /** Sets the driver of a vehicle, or clears it with null. [revision] must be the one that the caller last read. */
    @Synchronized
    fun assign(revision: Long, vehicleId: String, driver: String?): View {
        val current = view()
        if (current.revision != revision) {
            driverFail(HttpStatus.CONFLICT.value(), "ASSIGNMENT_REVISION_CONFLICT")
        }
        val next = LinkedHashMap(current.assignments)
        if (driver == null) next.remove(vehicleId) else next[vehicleId] = driver
        if (next.size > MAX_VEHICLES) driverFail(HttpStatus.BAD_REQUEST.value(), "TOO_MANY_ASSIGNMENTS")
        val root = driverJson.createObjectNode().put("version", VERSION).put("revision", revision + 1)
        root.putObject("assignments").apply { next.toSortedMap().forEach(::put) }
        try {
            writeAtomically(file, driverJson.writeValueAsBytes(root))
        } catch (_: IOException) {
            driverFail(HttpStatus.INTERNAL_SERVER_ERROR.value(), "DRIVER_ASSIGNMENTS_WRITE_FAILED")
        }
        return View(revision + 1, next)
    }

    private fun invalid(): Nothing = driverFail(HttpStatus.INTERNAL_SERVER_ERROR.value(), "DRIVER_ASSIGNMENTS_INVALID")

    private companion object {
        const val VERSION = 1
        const val MAX_BYTES = 1L * 1024 * 1024
        const val MAX_VEHICLES = 5_000
    }
}
