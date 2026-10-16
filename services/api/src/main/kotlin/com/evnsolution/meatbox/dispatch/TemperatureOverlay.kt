package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.node.ObjectNode

/** What the date snapshot shows of a vehicle's temperature: its newest value and the two warnings. */
class VehicleTemperature(val celsius: Double, val measuredAt: String, val stale: Boolean, val outOfRange: Boolean)

fun interface TemperatureSource {
    /** Must answer without waiting for any lock of the dispatch store. */
    fun perVehicle(): Map<String, VehicleTemperature>
}

/**
 * Today's snapshot shows each vehicle's newest temperature in `vehicleStates[v].temperature`. Other dates do not: a
 * measurement is a fact about now, not about the day. `sourceData.temperatureVersion` changes whenever anything shown
 * changes, including a vehicle turning stale with no new value, so the state's ETag follows it. Checkpoints keep
 * nothing of this.
 */
internal fun overlayTemperatures(state: ObjectNode, source: TemperatureSource?, today: String) {
    val sourceData = state.path("sourceData") as? ObjectNode
    val states = state.path("vehicleStates") as? ObjectNode
    val current = source != null && sourceData?.path("date")?.asString("") == today && states != null
    val shown = if (current) source.perVehicle().filterKeys { states.path(it) is ObjectNode }.toSortedMap() else null
    if (!shown.isNullOrEmpty()) show(sourceData as ObjectNode, states as ObjectNode, shown)
}

private fun show(sourceData: ObjectNode, states: ObjectNode, shown: Map<String, VehicleTemperature>) {
    shown.forEach { (vehicleId, value) ->
        (states.path(vehicleId) as ObjectNode).set("temperature", dispatchMapper.createObjectNode()
            .put("celsius", value.celsius).put("measuredAt", value.measuredAt)
            .put("stale", value.stale).put("outOfRange", value.outOfRange))
    }
    val digest = shown.entries.joinToString(";") { (id, v) ->
        "$id|${v.measuredAt}|${v.celsius}|${v.stale}|${v.outOfRange}"
    }
    sourceData.put("temperatureVersion", (digest.hashCode().toLong() and VERSION_MASK) + 1)
}

private const val VERSION_MASK = 0x7fffffffL
