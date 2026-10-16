package com.evnsolution.meatbox.integrations.webhook

import com.evnsolution.meatbox.ops.AlertChannel
import com.evnsolution.meatbox.ops.ErrorAlerts
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant

/**
 * POSTs `{subject, body, at, text}`. `text` is the same message in the one field Slack incoming webhooks
 * require; other receivers can ignore it. Throws on timeout or non-2xx, so [ErrorAlerts] logs the failure.
 */
class WebhookAlertChannel(
    url: String,
    private val timeout: Duration = DEFAULT_TIMEOUT,
    private val now: () -> Instant = Instant::now,
) : AlertChannel {
    private val uri = URI(url).also { require(it.scheme == "http" || it.scheme == "https") }
    private val client = HttpClient.newBuilder().connectTimeout(timeout)
        .followRedirects(HttpClient.Redirect.NEVER).build()

    override fun send(subject: String, body: String) {
        val json = mapper.writeValueAsString(
            mapOf("subject" to subject, "body" to body, "at" to now().toString(), "text" to "$subject\n$body"),
        )
        val request = HttpRequest.newBuilder(uri).timeout(timeout)
            .header("Content-Type", "application/json; charset=utf-8")
            .POST(HttpRequest.BodyPublishers.ofString(json)).build()
        val status = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
        check(status in SUCCESS) { "webhook status $status" }
    }

    private companion object {
        val DEFAULT_TIMEOUT: Duration = Duration.ofSeconds(5)
        val SUCCESS = 200..299
        val mapper: JsonMapper = JsonMapper.builder().build()
    }
}
