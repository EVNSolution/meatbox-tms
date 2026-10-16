package com.evnsolution.meatbox.legacy

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.writeAtomically
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * The delivery zones that an operator imported and edited: `{version, revision, regions: FeatureCollection}` in one
 * file of the state directory. While the file is valid its collection replaces the prepared `regions.geojson` for
 * every reader. Deleting the file's content (a save of null) falls back to the prepared zones. Only the zone's
 * `zoneId` and `label` are kept, so that nothing but a polygon and a name enters the system.
 *
 * Orders of a prepared CSV date carry the zone IDs of the prepared zones. A zone that this file drops, or a new zone
 * ID that no CSV date knows, therefore changes the zone boundaries on the map but not those orders' zone IDs.
 */
class CustomRegions(private val file: Path) {
    /** [collection] is null when nothing is saved (no file, or the zones were removed): the prepared zones apply. */
    class View(val revision: Long, val collection: ObjectNode?)

    private val mapper = JsonMapper.builder().build()

    /** The saved zones. An unreadable file throws `REGIONS_CUSTOM_INVALID`. */
    @Synchronized
    fun view(): View {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return View(0, null)
        val root = runCatching {
            check(Files.size(file) <= MAX_BYTES)
            mapper.readTree(Files.readAllBytes(file)) as ObjectNode
        }.getOrNull()
        val regions = root?.path("regions")
        val valid = root != null && root.path("version").asInt() == VERSION && root.path("revision").isIntegralNumber &&
            (regions!!.isNull || regions.isObject)
        if (!valid) throw invalid()
        return View(root!!.path("revision").asLong(), regions as? ObjectNode)
    }

    /** The collection as served to readers, or null when there is none or the file is unreadable. */
    fun bytes(): ByteArray? = runCatching { view().collection?.let(mapper::writeValueAsBytes) }.getOrNull()

    /**
     * Replaces the zones with [collection] (checked and reduced to polygons and names), or removes them with null.
     * The revision only grows, also across a removal, so a stale writer never matches a newer file.
     */
    @Synchronized
    fun save(revision: Long, collection: JsonNode?): View {
        val current = view()
        if (current.revision != revision) {
            throw fail(HttpStatus.CONFLICT, "REGIONS_REVISION_CONFLICT")
        }
        val next = collection?.takeUnless(JsonNode::isNull)?.let(RegionsValidator::clean)
        val root = mapper.createObjectNode().put("version", VERSION).put("revision", revision + 1)
        if (next == null) root.putNull("regions") else root.set("regions", next)
        try {
            writeAtomically(file, mapper.writeValueAsBytes(root))
        } catch (_: IOException) {
            throw fail(HttpStatus.INTERNAL_SERVER_ERROR, "REGIONS_WRITE_FAILED")
        }
        return View(revision + 1, next)
    }

    private fun invalid() = fail(HttpStatus.INTERNAL_SERVER_ERROR, "REGIONS_CUSTOM_INVALID")

    private fun fail(status: HttpStatus, code: String) = DispatchException(status.value(), code, code)

    private companion object {
        const val VERSION = 1
        const val MAX_BYTES = 12L * 1024 * 1024
    }
}

/** What an imported FeatureCollection must be to become the zones. Everything else is refused as `INVALID_REGIONS`. */
internal object RegionsValidator {
    private val ZONE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    private const val MAX_ZONES = 500
    private const val MAX_VERTICES = 200_000
    private const val MAX_LABEL = 100
    private const val MIN_RING = 4
    private const val MAX_LAT = 90.0
    private const val MAX_LNG = 180.0
    private val mapper = JsonMapper.builder().build()

    private fun refuse(): Nothing =
        throw DispatchException(HttpStatus.BAD_REQUEST.value(), "INVALID_REGIONS", "INVALID_REGIONS")

    fun clean(input: JsonNode): ObjectNode {
        val features = input.path("features")
        if (input.path("type").asString("") != "FeatureCollection" || !features.isArray) refuse()
        if (features.isEmpty || features.size() > MAX_ZONES) refuse()
        val out = mapper.createObjectNode().put("type", "FeatureCollection")
        val seen = HashSet<String>()
        var vertices = 0
        val list = out.putArray("features")
        for (feature in features) {
            val zoneId = feature.path("properties").path("zoneId").takeIf { it.isString }?.asString().orEmpty()
            if (!ZONE_ID.matches(zoneId) || !seen.add(zoneId)) refuse()
            val geometry = cleanGeometry(feature.path("geometry"))
            vertices += geometry.second
            if (vertices > MAX_VERTICES) refuse()
            list.add(
                mapper.createObjectNode().put("type", "Feature").also { node ->
                    node.putObject("properties").put("zoneId", zoneId).put("label", labelOf(feature, zoneId))
                    node.set("geometry", geometry.first)
                },
            )
        }
        return out
    }

    private fun labelOf(feature: JsonNode, zoneId: String): String {
        val label = feature.path("properties").path("label")
        if (label.isNull || label.isMissingNode) return zoneId
        val text = label.takeIf { it.isString }?.asString()?.trim().orEmpty()
        if (text.length > MAX_LABEL || text.any { it.isISOControl() }) refuse()
        return text.ifEmpty { zoneId }
    }

    /** The polygon(s) with only longitude and latitude, and how many vertices they hold. */
    private fun cleanGeometry(geometry: JsonNode): Pair<ObjectNode, Int> {
        val type = geometry.path("type").asString("")
        val coordinates = geometry.path("coordinates")
        val polygons = when (type) {
            "Polygon" -> listOf(coordinates)
            "MultiPolygon" -> if (coordinates.isArray) coordinates.toList() else refuse()
            else -> refuse()
        }
        if (polygons.isEmpty()) refuse()
        var count = 0
        val cleaned = polygons.map { polygon ->
            val (rings, size) = cleanPolygon(polygon)
            count += size
            rings
        }
        val out = mapper.createObjectNode().put("type", type)
        val all = mapper.createArrayNode().apply { cleaned.forEach(::add) }
        out.set("coordinates", if (type == "Polygon") cleaned.first() else all)
        return out to count
    }

    private fun cleanPolygon(polygon: JsonNode): Pair<ArrayNode, Int> {
        if (!polygon.isArray || polygon.isEmpty) refuse()
        var count = 0
        val rings = mapper.createArrayNode()
        for (ring in polygon) {
            if (!ring.isArray || ring.size() < MIN_RING || ring.first() != ring.last()) refuse()
            val out = mapper.createArrayNode()
            for (position in ring) {
                val lng = position.path(0)
                val lat = position.path(1)
                val ok = position.isArray && lng.isNumber && lat.isNumber &&
                    lng.asDouble() in -MAX_LNG..MAX_LNG && lat.asDouble() in -MAX_LAT..MAX_LAT
                if (!ok) refuse()
                out.add(mapper.createArrayNode().add(lng.asDouble()).add(lat.asDouble()))
            }
            count += out.size()
            rings.add(out)
        }
        return rings to count
    }
}
