package com.evnsolution.meatbox.telemetry

import org.slf4j.LoggerFactory
import tools.jackson.databind.JsonNode
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.attribute.FileTime

/** An allowed band. A missing bound is open: frozen goods only have a ceiling. */
class Range(val min: Double?, val max: Double?) {
    fun allows(celsius: Double): Boolean = (min == null || celsius >= min) && (max == null || celsius <= max)
}

private const val FROZEN_CEILING = -18.0
private const val CHILLED_CEILING = 5.0
private val KINDS = mapOf("frozen" to Range(null, FROZEN_CEILING), "chilled" to Range(0.0, CHILLED_CEILING))
private val log = LoggerFactory.getLogger("com.evnsolution.meatbox.telemetry.Ranges")

/**
 * The allowed temperature of a vehicle. A measurement's own `compartment` wins, then the vehicle's entry in
 * `ranges.json` (`{"V-021": {"kind": "frozen"}, "V-030": {"min": 0, "max": 5}}`), then [defaultKind]. With none of
 * them the vehicle is not judged, because a default would raise false alarms on the other kind of vehicle.
 * ponytail: a file in the state directory is a stopgap; the range belongs in the vehicle register's `vehicles` table.
 * The file is read again when its modification time changes. A broken file leaves every vehicle with the other rules
 * and calls [onInvalid] once per change.
 */
class TemperatureRanges(
    private val file: Path,
    private val defaultKind: String?,
    private val onInvalid: () -> Unit = {},
) {
    private var loadedAt: FileTime? = null
    private var entries: Map<String, Range> = emptyMap()

    @Synchronized
    fun of(vehicleId: String, compartment: String?): Range? =
        compartment?.let(KINDS::get) ?: entries()[vehicleId] ?: defaultKind?.let(KINDS::get)

    private fun entries(): Map<String, Range> {
        val modified = runCatching { Files.getLastModifiedTime(file, NOFOLLOW_LINKS) }.getOrNull()
        if (modified != loadedAt) {
            loadedAt = modified
            entries = if (modified == null) emptyMap() else runCatching { parse(file) }.getOrElse {
                log.warn("ranges.json is not usable: {}", it.javaClass.simpleName)
                onInvalid()
                emptyMap()
            }
        }
        return entries
    }

    private fun parse(path: Path): Map<String, Range> {
        val root = telemetryJson.readTree(Files.readAllBytes(path))
        check(root.isObject)
        return root.properties().associate { (vehicleId, entry) ->
            check(validVehicleId(vehicleId))
            vehicleId to range(entry)
        }
    }

    private fun range(entry: JsonNode): Range {
        check(entry.isObject)
        val kind = entry.get("kind")
        if (kind != null) return KINDS.getValue(kind.asString())
        val bounds = listOf("min", "max").map { key ->
            entry.get(key)?.also { check(it.isNumber && it.doubleValue().isFinite()) }?.doubleValue()
        }
        check(bounds.any { it != null } && (bounds[0] == null || bounds[1] == null || bounds[0]!! <= bounds[1]!!))
        return Range(bounds[0], bounds[1])
    }
}
