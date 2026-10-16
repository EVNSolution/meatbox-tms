package com.evnsolution.meatbox.dispatch

import jakarta.servlet.http.HttpServletResponse
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode

/**
 * The latest ETA of each vehicle, kept in the date's checkpoint next to the outbox so an ETA and the departure that
 * caused it are written by the same file write. The engine does not know them; the public view lays them over
 * `vehicleStates[vehicleId].eta`.
 */
internal object Etas {
    fun toNode(etas: Map<String, ObjectNode>): JsonNode = dispatchMapper.createObjectNode().apply {
        etas.forEach { (vehicleId, eta) -> set(vehicleId, eta) }
    }

    /** A checkpoint without the field has no ETAs, so files written before it existed still load. */
    fun fromCheckpoint(saved: ObjectNode?): Map<String, ObjectNode> {
        val node = saved?.get("etas") ?: return emptyMap()
        if (node !is ObjectNode) invalid()
        return node.properties().associate { (vehicleId, value) ->
            val eta = value as? ObjectNode ?: invalid()
            if (!eta.path("computedAt").isString || !eta.path("stops").isArray) invalid()
            vehicleId to eta
        }
    }

    /** Lays each vehicle's ETA over the snapshot's `vehicleStates`. Vehicles the snapshot lacks are skipped. */
    fun overlay(snapshot: ObjectNode, etas: Map<String, ObjectNode>): ObjectNode {
        val states = snapshot.path("vehicleStates") as? ObjectNode ?: return snapshot
        etas.forEach { (vehicleId, eta) -> (states.path(vehicleId) as? ObjectNode)?.set("eta", copyObject(eta)) }
        // A zone entry recomputes without any engine command, so the state's revision alone would not show the change.
        val version = etas.values.sumOf { it.path("recomputes").asInt(0) }
        if (version > 0) (snapshot.path("sourceData") as? ObjectNode)?.put("etaVersion", version)
        return snapshot
    }

    private fun invalid(): Nothing = throw DispatchException(
        HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
        "DISPATCH_STATE_INVALID",
        "DISPATCH_STATE_INVALID",
    )
}
