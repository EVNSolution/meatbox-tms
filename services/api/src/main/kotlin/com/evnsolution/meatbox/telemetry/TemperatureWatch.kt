package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.VehicleTemperature
import com.evnsolution.meatbox.ops.ErrorAlerts
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

private const val CONFIRMING_READINGS = 3

/**
 * Judges stored measurements against the vehicle's range. A sensor goes out of range after [CONFIRMING_READINGS]
 * readings in a row outside it (one reading is a door opening), and one alert is sent on that change only.
 * It is back in range at the first reading inside. The state lives in memory: after a restart a sensor that is still
 * out of range is confirmed again by three more readings. Readings older than the stale window are history and do
 * not change the state.
 */
class TemperatureWatch(
    private val store: TemperatureStore,
    private val ranges: TemperatureRanges,
    private val alerts: ErrorAlerts,
) {
    private class State(var streak: Int = 0, var out: Boolean = false)

    private val states = ConcurrentHashMap<Pair<String, String>, State>()

    @Synchronized
    fun observe(vehicleId: String, fresh: List<Reading>) {
        val horizon = store.now().minus(store.staleAfter)
        fresh.filter { !it.measuredAt.isBefore(horizon) }.sortedBy { it.measuredAt }.forEach { reading ->
            val range = ranges.of(vehicleId, reading.compartment) ?: return@forEach
            val state = states.getOrPut(vehicleId to reading.sensorId) { State() }
            state.streak = if (range.allows(reading.celsius)) 0 else state.streak + 1
            val out = state.streak >= CONFIRMING_READINGS
            if (out && !state.out) alert(vehicleId, reading, range)
            state.out = out
        }
    }

    private fun alert(vehicleId: String, reading: Reading, range: Range) {
        val band = "${range.min ?: "-"}..${range.max ?: "-"}"
        alerts.report(
            "telemetry", "OUT_OF_RANGE",
            "vehicleId=$vehicleId sensorId=${reading.sensorId} celsius=${reading.celsius} range=$band",
        )
    }

    fun outOfRange(latest: Latest): Boolean = states[latest.vehicleId to latest.sensorId]?.out == true

    fun rangeOf(latest: Latest): Range? = ranges.of(latest.vehicleId, latest.compartment)

    /** One value per vehicle for the date snapshot: the newest sensor's reading, stale only when every sensor is. */
    fun perVehicle(): Map<String, VehicleTemperature> = store.latest().groupBy { it.vehicleId }.mapValues { (_, all) ->
        val newest = all.maxBy { it.measuredAt }
        VehicleTemperature(newest.celsius, stamp(newest.measuredAt), all.all(store::stale), all.any(::outOfRange))
    }

    fun now(): Instant = store.now()
}
