package com.evnsolution.meatbox.eta

import com.evnsolution.meatbox.ops.ErrorAlerts
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant

/**
 * The order of the free stops from a routing engine. [stops] are the free stops that have coordinates; [first], when
 * set, is one of them and must come first. Returns every stop ID once, or null when the engine has no answer
 * (the caller then plans the order itself).
 */
fun interface RouteOptimizer {
    fun order(stops: List<PlanStop>, origin: EtaPoint?, first: String?): List<String>?
}

/**
 * VROOM `POST /` with one vehicle and one job per stop (`g: false`: no road geometry). The vehicle starts at [origin],
 * or at the [first] stop, which then is not a job: it leads the answer. The route is open: no end point. After a
 * failure the engine is not asked again for [BACKOFF_SECONDS].
 */
class VroomOptimizer(
    url: String,
    private val alerts: ErrorAlerts? = null,
    private val timeout: Duration = DEFAULT_TIMEOUT,
    private val now: () -> Instant = Instant::now,
) : RouteOptimizer {
    private val uri = URI(url).also { require(it.scheme == "http" || it.scheme == "https") }
    private val client = HttpClient.newBuilder().connectTimeout(timeout)
        .followRedirects(HttpClient.Redirect.NEVER).build()

    @Volatile private var retryAfter: Instant = Instant.MIN

    override fun order(stops: List<PlanStop>, origin: EtaPoint?, first: String?): List<String>? {
        val lead = stops.firstOrNull { it.stopId == first }
        val jobs = stops.filter { it !== lead }
        val start = lead?.point ?: origin
        val at = now()
        val tooSmall = jobs.isEmpty() || start == null
        return when {
            stops.size > MAX_STOPS || at.isBefore(retryAfter) -> null
            tooSmall -> if (jobs.isEmpty() && lead != null) listOf(lead.stopId) else null
            else -> try {
                listOfNotNull(lead?.stopId) + ask(jobs, start!!)
            } catch (_: StopsRejected) { // the engine is up; one stop has no road (VROOM code 2 or 3)
                null
            } catch (@Suppress("TooGenericExceptionCaught") error: Exception) { // any failure falls back to 2-opt
                retryAfter = at.plusSeconds(BACKOFF_SECONDS)
                alerts?.report("route-engine", "VROOM_UNAVAILABLE", "${error.javaClass.simpleName}: ${error.message}")
                null
            }
        }
    }

    private fun ask(jobs: List<PlanStop>, start: EtaPoint): List<String> {
        val body = mapper.createObjectNode().apply {
            putArray("vehicles").addObject().put("id", 1).put("profile", "car").putArray("start")
                .add(start.lng).add(start.lat)
            putArray("jobs").apply {
                jobs.forEachIndexed { index, stop ->
                    addObject().put("id", index + 1).putArray("location").add(stop.point!!.lng).add(stop.point.lat)
                }
            }
            putObject("options").put("g", false)
        }
        val request = HttpRequest.newBuilder(uri).timeout(timeout)
            .header("Content-Type", "application/json; charset=utf-8")
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body))).build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        val json = runCatching { mapper.readTree(response.body()) }.getOrNull()
        val code = json?.path("code")?.asInt(-1) ?: -1
        if (code in REJECTED_CODES) throw StopsRejected()
        check(response.statusCode() == STATUS_OK && json != null && code == 0) {
            "vroom status ${response.statusCode()} code $code"
        }
        check(json.path("unassigned").size() == 0) { "vroom left stops unassigned" }
        val ids = json.path("routes").path(0).path("steps").filter { it.path("type").asString("") == "job" }
            .map { jobs[it.path("id").asInt() - 1].stopId }
        check(ids.sorted() == jobs.map { it.stopId }.sorted()) { "vroom answer does not hold every stop once" }
        return ids
    }

    /** VROOM answered but cannot plan these stops (input error, or a stop no road reaches): not an outage. */
    private class StopsRejected : RuntimeException()

    private companion object {
        val REJECTED_CODES = setOf(2, 3)
        const val MAX_STOPS = 200
        const val BACKOFF_SECONDS = 30L
        const val STATUS_OK = 200
        val DEFAULT_TIMEOUT: Duration = Duration.ofSeconds(3)
        val mapper: JsonMapper = JsonMapper.builder().build()
    }
}
