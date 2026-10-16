package com.evnsolution.meatbox.integrations.meatbox.outbound

import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxItem
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Sends one outbox message to Meatbox: `POST {base}/tms/<kind>` with `Idempotency-Key`, a Bearer token when one is
 * set, and a body timeout. The path per kind is a placeholder until Meatbox names its endpoints (contract 7.2).
 * Returns the status code; I/O failures and timeouts throw. The token never leaves this class.
 */
class MeatboxClient(baseUrl: String, private val token: String, private val timeout: Duration = TIMEOUT) {
    private val base = baseUrl.trim().trimEnd('/')
    val enabled: Boolean get() = base.isNotEmpty()

    init {
        if (enabled) {
            val scheme = URI(base).scheme
            require(scheme == "http" || scheme == "https") { "MEATBOX_API_BASE_URL must be http(s)" }
        }
    }

    private val client = HttpClient.newBuilder().connectTimeout(timeout)
        .followRedirects(HttpClient.Redirect.NEVER).build()

    fun post(item: OutboxItem): Int {
        val path = PATHS[item.kind] ?: throw IllegalArgumentException("unsupported kind")
        val request = HttpRequest.newBuilder(URI("$base$path")).timeout(timeout)
            .header("Content-Type", "application/json").header("Idempotency-Key", item.messageId)
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(item.body)))
        if (token.isNotBlank()) request.header("Authorization", "Bearer $token")
        return client.send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode()
    }

    companion object {
        val TIMEOUT: Duration = Duration.ofSeconds(10)
        private val PATHS = mapOf(
            "delivery-status" to "/tms/delivery-status",
            "eta" to "/tms/eta",
            "temperature" to "/tms/temperature",
        )
        private val mapper: JsonMapper = JsonMapper.builder().build()
    }
}
