package com.evnsolution.meatbox.legacy

import com.evnsolution.meatbox.auth.SessionVerifier
import tools.jackson.databind.json.JsonMapper
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Flow
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

class LegacySessionVerifier(
    private val client: HttpClient,
    legacyApiOrigin: URI,
    private val timeout: Duration = Duration.ofSeconds(2),
) : SessionVerifier {
    private val sessionUri = legacyApiOrigin.resolve("/api/session")
    private val mapper = JsonMapper.builder().build()

    override fun verify(cookie: String?): String = validate(fetch(cookie))

    private fun fetch(cookie: String?): HttpResponse<ByteArray> {
        val builder = HttpRequest.newBuilder(sessionUri)
            .timeout(timeout)
            .header("Accept", "application/json")
            .GET()
        if (!cookie.isNullOrBlank()) builder.header("Cookie", cookie)
        val requestFuture = client.sendAsync(builder.build()) { LimitedBodySubscriber(MAX_BODY_BYTES) }
        return try {
            requestFuture.get(timeout.toMillis(), TimeUnit.MILLISECONDS)
        } catch (error: TimeoutException) {
            requestFuture.cancel(true)
            failSession(error)
        } catch (error: ExecutionException) {
            failSession(error.cause ?: error)
        } catch (error: InterruptedException) {
            requestFuture.cancel(true)
            Thread.currentThread().interrupt()
            failSession(error)
        }
    }

    private fun validate(response: HttpResponse<ByteArray>): String {
        if (response.statusCode() == HTTP_UNAUTHORIZED) throw LoginRequiredException()
        val username = if (response.statusCode() == HTTP_OK && response.isJson()) username(response.body()) else null
        if (username == null) {
            throw SessionUnavailableException("LEGACY_SESSION_UNAVAILABLE")
        }
        return username
    }

    private fun username(body: ByteArray): String? = runCatching {
        val root = mapper.readTree(body)
        val username = root.takeIf { it.isObject }?.get("user")
            ?.takeIf { it.isObject }?.get("username")
        username?.takeIf { it.isString }?.asString()?.takeIf(USERNAME_PATTERN::matches)
    }.getOrNull()

    private fun HttpResponse<ByteArray>.isJson(): Boolean = headers().firstValue("Content-Type")
        .map { it.substringBefore(';').trim().equals("application/json", ignoreCase = true) }
        .orElse(false)

    private fun failSession(error: Throwable): Nothing =
        throw SessionUnavailableException("LEGACY_SESSION_UNAVAILABLE", error)

    private class LimitedBodySubscriber(private val maximum: Int) : HttpResponse.BodySubscriber<ByteArray> {
        private val result = CompletableFuture<ByteArray>()
        private val output = ByteArrayOutputStream()
        private val completed = AtomicBoolean()
        private var subscription: Flow.Subscription? = null

        override fun getBody(): CompletableFuture<ByteArray> = result

        override fun onSubscribe(subscription: Flow.Subscription) {
            this.subscription = subscription
            subscription.request(Long.MAX_VALUE)
        }

        override fun onNext(item: List<ByteBuffer>) {
            if (completed.get()) return
            for (buffer in item) {
                if (output.size() + buffer.remaining() > maximum) {
                    fail(IllegalStateException("Legacy session response exceeded the allowed size"))
                    return
                }
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                output.write(bytes)
            }
        }

        override fun onError(throwable: Throwable) = fail(throwable)

        override fun onComplete() {
            if (completed.compareAndSet(false, true)) result.complete(output.toByteArray())
        }

        private fun fail(error: Throwable) {
            if (completed.compareAndSet(false, true)) {
                subscription?.cancel()
                result.completeExceptionally(error)
            }
        }
    }

    companion object {
        const val MAX_BODY_BYTES = 16 * 1024
        private const val HTTP_OK = 200
        private const val HTTP_UNAUTHORIZED = 401
        private val USERNAME_PATTERN = Regex("^[A-Za-z0-9](?:[A-Za-z0-9_.-]){2,39}$")
    }
}

typealias LoginRequiredException = com.evnsolution.meatbox.auth.LoginRequiredException
typealias SessionUnavailableException = com.evnsolution.meatbox.auth.SessionUnavailableException
