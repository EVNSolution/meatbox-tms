package com.evnsolution.meatbox.eta

import java.time.Instant
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/** A WGS84 point. */
data class EtaPoint(val lat: Double, val lng: Double)

/** One stop in route order. A stop without coordinates has a null [point]. */
class EtaStopInput(val stopId: String, val point: EtaPoint?)

/** [estimated] is false when the arrival could not use a travel time, so it only adds the previous work time. */
class EtaStop(val stopId: String, val sequence: Int, val eta: Instant, val estimated: Boolean)

/**
 * The first model's knobs (contract 3.2 has no say in them). Travel time is straight-line distance times
 * [detourFactor] at [speedKmh]; every stop adds [serviceMinutes] of work before the next leg. A recomputed ETA that
 * moved by [delayThresholdMinutes] or more from the last one sent to Meatbox is sent again.
 */
data class EtaConfig(
    val detourFactor: Double = 1.4,
    val speedKmh: Double = 25.0,
    val serviceMinutes: Int = 5,
    val delayThresholdMinutes: Int = 10,
) {
    init {
        require(detourFactor.isFinite() && detourFactor > 0) { "meatbox.eta.detour-factor must be above 0" }
        require(speedKmh.isFinite() && speedKmh > 0) { "meatbox.eta.speed-kmh must be above 0" }
        require(serviceMinutes >= 0) { "meatbox.eta.service-minutes must not be negative" }
        require(delayThresholdMinutes >= 1) { "meatbox.eta.delay-threshold-minutes must be at least 1" }
    }
}

/** Travel time between two points. A routing API replaces [HaversineEstimator] behind this one method. */
fun interface TravelTimeEstimator {
    fun seconds(from: EtaPoint, to: EtaPoint): Int
}

class HaversineEstimator(private val config: EtaConfig) : TravelTimeEstimator {
    override fun seconds(from: EtaPoint, to: EtaPoint): Int {
        val km = kilometres(from, to) * config.detourFactor
        return (km / config.speedKmh * SECONDS_PER_HOUR).roundToLong().toInt()
    }

    private fun kilometres(from: EtaPoint, to: EtaPoint): Double {
        val dLat = Math.toRadians(to.lat - from.lat)
        val dLng = Math.toRadians(to.lng - from.lng)
        val cosines = cos(Math.toRadians(from.lat)) * cos(Math.toRadians(to.lat))
        val a = sin(dLat / 2).pow(2) + cosines * sin(dLng / 2).pow(2)
        return 2 * EARTH_RADIUS_KM * asin(sqrt(a))
    }

    private companion object {
        const val EARTH_RADIUS_KM = 6371.0088
        const val SECONDS_PER_HOUR = 3600
    }
}

/** Arrival times along one route. Pure: the caller owns where the stops, departure and origin come from. */
class EtaModel(
    val config: EtaConfig = EtaConfig(),
    val estimator: TravelTimeEstimator = HaversineEstimator(config),
) {
    /**
     * Arrival at stop 1 is the departure plus the leg from [origin]; each later arrival adds the previous stop's work
     * time and the leg from the last known point. A missing origin or stop point makes that leg zero and the stop
     * `estimated = false`. Times round to the minute, as contract 3.2 shows them.
     */
    fun compute(stops: List<EtaStopInput>, departure: Instant, origin: EtaPoint?): List<EtaStop> {
        var seconds = departure.epochSecond
        var position = origin
        return stops.mapIndexed { index, stop ->
            if (index > 0) seconds += config.serviceMinutes * SECONDS_PER_MINUTE
            val leg = if (position != null && stop.point != null) estimator.seconds(position!!, stop.point) else null
            seconds += leg ?: 0
            stop.point?.let { position = it }
            EtaStop(stop.stopId, index + 1, roundToMinute(seconds), leg != null)
        }
    }

    private fun roundToMinute(epochSeconds: Long): Instant =
        Instant.ofEpochSecond((epochSeconds.toDouble() / SECONDS_PER_MINUTE).roundToLong() * SECONDS_PER_MINUTE)

    private companion object {
        const val SECONDS_PER_MINUTE = 60L
    }
}
