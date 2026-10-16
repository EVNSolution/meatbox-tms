package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.node.ObjectNode

/** `byVehicle` values are vehicle `location` objects; `version` changes whenever any of them does. */
class DriverLocations(val version: Long, val byVehicle: Map<String, ObjectNode>)

fun interface DriverLocationSource {
    fun latest(date: String): DriverLocations
}

/**
 * Driver-reported positions replace the synthetic fleet coordinates in the public view only.
 * Checkpoints keep the plan's own positions.
 */
internal fun overlayDriverLocations(state: ObjectNode, source: DriverLocationSource?) {
    val sourceData = state.path("sourceData") as? ObjectNode
    val reported = source?.latest(sourceData?.path("date")?.asString("").orEmpty())
    if (sourceData == null || reported == null || reported.byVehicle.isEmpty()) return
    sourceData.put("driverLocationVersion", reported.version)
    state.path("fleetVehicles").forEach { place(it as? ObjectNode, reported) }
    place(state.path("vehicle") as? ObjectNode, reported)
    (state.path("vehicleStates") as? ObjectNode)?.properties()?.forEach { (id, vehicleState) ->
        moveTruck(vehicleState.path("truck") as? ObjectNode, reported, id)
    }
    moveTruck(state.path("truck") as? ObjectNode, reported, sourceData.path("defaultVehicleId").asString(""))
}

private fun place(vehicle: ObjectNode?, reported: DriverLocations) {
    val location = reported.byVehicle[vehicle?.path("id")?.asString("").orEmpty()] ?: return
    vehicle?.set("location", copyObject(location))
}

private fun moveTruck(truck: ObjectNode?, reported: DriverLocations, vehicleId: String) {
    val position = reported.byVehicle[vehicleId]?.path("coordinates") ?: return
    truck?.put("lng", position[0].doubleValue())?.put("lat", position[1].doubleValue())?.put("locationSource", "driver")
}
