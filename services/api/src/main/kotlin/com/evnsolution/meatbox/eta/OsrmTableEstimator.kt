package com.evnsolution.meatbox.eta

import com.evnsolution.meatbox.ops.ErrorAlerts
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt

/** Road travel time and distance between every pair of [points], from one OSRM table (`-1`: no road found). */
internal class RoadMatrix(val points: List<EtaPoint>, val seconds: Array<IntArray>, val meters: Array<IntArray>) {
    private val index = points.withIndex().associate { it.value to it.index }

    fun covers(from: EtaPoint, to: EtaPoint) = from in index && to in index

    fun seconds(from: EtaPoint, to: EtaPoint): Int? = at(seconds, from, to)

    fun meters(from: EtaPoint, to: EtaPoint): Int? = at(meters, from, to)

    private fun at(grid: Array<IntArray>, from: EtaPoint, to: EtaPoint) =
        grid[index.getValue(from)][index.getValue(to)].takeIf { it >= 0 }
}

/**
 * Travel times from OSRM `GET /table/v1/car/{lng,lat;...}?annotations=duration,distance`. [prepare] asks for all points
 * of one calculation in one request and keeps the table for [CACHE_SECONDS]; [seconds] and [meters] then read it. Every
 * pair the table does not hold (engine down, too many points, no road) is answered by [fallback]. After a failure the
 * engine is not asked again for [BACKOFF_SECONDS], so a dead engine costs one timeout, not one per request.
 */
class OsrmTableEstimator(
    baseUrl: String,
    private val fallback: TravelTimeEstimator,
    private val alerts: ErrorAlerts? = null,
    private val timeout: Duration = DEFAULT_TIMEOUT,
    private val now: () -> Instant = Instant::now,
) : TravelTimeEstimator {
    private val base = URI(baseUrl.trimEnd('/')).also { require(it.scheme == "http" || it.scheme == "https") }
    private val client = HttpClient.newBuilder().connectTimeout(timeout)
        .followRedirects(HttpClient.Redirect.NEVER).build()
    private val tables = ConcurrentHashMap<List<EtaPoint>, Pair<RoadMatrix, Instant>>()

    @Volatile private var retryAfter: Instant = Instant.MIN

    override fun prepare(points: List<EtaPoint>): String? {
        val distinct = points.distinct()
        return when {
            distinct.size < 2 -> null
            distinct.size > MAX_POINTS -> HAVERSINE
            else -> if (table(distinct) != null) OSRM else HAVERSINE
        }
    }

    override fun seconds(from: EtaPoint, to: EtaPoint): Int =
        live().firstOrNull { it.covers(from, to) }?.seconds(from, to) ?: fallback.seconds(from, to)

    override fun meters(from: EtaPoint, to: EtaPoint): Int? =
        live().firstOrNull { it.covers(from, to) }?.meters(from, to)

    private fun live(): List<RoadMatrix> {
        val at = now()
        tables.values.removeIf { it.second.isBefore(at) }
        return tables.values.map { it.first }
    }

    private fun table(distinct: List<EtaPoint>): RoadMatrix? {
        val key = distinct.sortedWith(compareBy({ it.lat }, { it.lng }))
        val at = now()
        val cached = tables[key]?.takeIf { !it.second.isBefore(at) }?.first
        return cached ?: if (at.isBefore(retryAfter)) null else ask(key, at)
    }

    private fun ask(key: List<EtaPoint>, at: Instant): RoadMatrix? = try {
        fetch(key).also { tables[key] = it to at.plusSeconds(CACHE_SECONDS) }
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) { // any failure falls back to straight lines
        retryAfter = at.plusSeconds(BACKOFF_SECONDS)
        alerts?.report("route-engine", "OSRM_UNAVAILABLE", "${error.javaClass.simpleName}: ${error.message}")
        null
    }

    private fun fetch(points: List<EtaPoint>): RoadMatrix {
        val coordinates = points.joinToString(";") { "${it.lng},${it.lat}" }
        val request = HttpRequest.newBuilder(URI("$base/table/v1/car/$coordinates?annotations=duration,distance"))
            .timeout(timeout).GET().build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        check(response.statusCode() == STATUS_OK) { "osrm status ${response.statusCode()}" }
        val json = mapper.readTree(response.body())
        check(json.path("code").asString("") == "Ok") { "osrm code ${json.path("code").asString("")}" }
        return RoadMatrix(points, grid(json.path("durations"), points.size), grid(json.path("distances"), points.size))
    }

    private fun grid(node: JsonNode, size: Int): Array<IntArray> {
        check(node.size() == size) { "osrm table size ${node.size()}" }
        return Array(size) { row ->
            check(node[row].size() == size) { "osrm table row size" }
            IntArray(size) { column ->
                val cell = node[row][column]
                if (cell.isNumber) cell.doubleValue().roundToInt() else -1
            }
        }
    }

    companion object {
        /** The most points one table holds (contract: 200 stops per route). */
        const val MAX_POINTS = 200
        const val OSRM = "osrm"
        const val HAVERSINE = "haversine"
        private const val CACHE_SECONDS = 60L
        private const val BACKOFF_SECONDS = 30L
        private const val STATUS_OK = 200
        private val DEFAULT_TIMEOUT: Duration = Duration.ofSeconds(3)
        private val mapper: JsonMapper = JsonMapper.builder().build()
    }
}
