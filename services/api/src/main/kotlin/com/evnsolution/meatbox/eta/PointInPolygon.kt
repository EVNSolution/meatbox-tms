package com.evnsolution.meatbox.eta

import tools.jackson.databind.JsonNode

/**
 * Ray casting: whether [point] lies inside a GeoJSON `Polygon` or `MultiPolygon` (`[lng, lat]` positions). A hole
 * subtracts from its polygon. A point exactly on an edge may count either way; any other geometry type is outside.
 */
fun insideGeometry(geometry: JsonNode, point: EtaPoint): Boolean {
    fun inRing(ring: JsonNode): Boolean {
        var inside = false
        var previous = ring.size() - 1
        for (index in 0 until ring.size()) {
            val (x1, y1) = ring[index][0].doubleValue() to ring[index][1].doubleValue()
            val (x2, y2) = ring[previous][0].doubleValue() to ring[previous][1].doubleValue()
            val crosses = (y1 > point.lat) != (y2 > point.lat) &&
                point.lng < (x2 - x1) * (point.lat - y1) / (y2 - y1) + x1
            if (crosses) inside = !inside
            previous = index
        }
        return inside
    }
    fun inPolygon(rings: JsonNode) =
        rings.size() > 0 && inRing(rings[0]) && (1 until rings.size()).none { inRing(rings[it]) }
    val coordinates = geometry.path("coordinates")
    return when (geometry.path("type").asString("")) {
        "Polygon" -> inPolygon(coordinates)
        "MultiPolygon" -> coordinates.any(::inPolygon)
        else -> false
    }
}
