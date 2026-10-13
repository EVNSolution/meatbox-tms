package com.evnsolution.meatbox.driver

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Duration
import java.time.Instant
import java.util.Base64

/** HTTP v1 accepted means Google accepted the message, not confirmed device delivery. */
class FcmSender(
    private val accountFile: String,
    private val projectId: String,
    private val transport: FcmTransport = GoogleFcmTransport(),
    private val now: () -> Instant = Instant::now,
) {
    @Volatile private var cached: AccessToken? = null

    fun send(tokens: List<String>, date: String, vehicleId: String, messageId: String): PushSummary {
        return when {
            accountFile.isBlank() || projectId.isBlank() -> PushSummary("unconfigured")
            tokens.isEmpty() -> PushSummary("no-device")
            else -> sendConfigured(tokens, date, vehicleId, messageId)
        }
    }

    private fun sendConfigured(tokens: List<String>, date: String, vehicleId: String, messageId: String): PushSummary {
        val deadline = System.nanoTime() + SEND_BUDGET.toNanos()
        val access = runCatching { accessToken(deadline) }.getOrNull()
            ?: return PushSummary("failed", tokens.size, 0, tokens.size)
        var sent = 0
        for (token in tokens) {
            if (runCatching { deliver(access, token, date, vehicleId, messageId, deadline) }.getOrDefault(false)) sent++
        }
        val status = when (sent) {
            tokens.size -> "sent"
            0 -> "failed"
            else -> "partial"
        }
        return PushSummary(status, tokens.size, sent, tokens.size - sent)
    }

    private fun accessToken(deadline: Long): String {
        cached?.takeIf { it.expiresAt.isAfter(now().plusSeconds(REFRESH_MARGIN)) }?.let { return it.value }
        require(PROJECT.matches(projectId))
        val account = credentials()
        val issued = now().epochSecond
        val header = driverJson.createObjectNode().put("alg", "RS256").put("typ", "JWT")
        val claims = driverJson.createObjectNode().put("iss", account.email).put("scope", SCOPE)
            .put("aud", TOKEN_URL).put("iat", issued).put("exp", issued + TOKEN_SECONDS)
        val unsigned = "${encode(driverJson.writeValueAsBytes(header))}.${encode(driverJson.writeValueAsBytes(claims))}"
        val signer = Signature.getInstance("SHA256withRSA")
        signer.initSign(KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(account.key)))
        signer.update(unsigned.toByteArray(UTF_8))
        val assertion = "$unsigned.${encode(signer.sign())}"
        val form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
            URLEncoder.encode(assertion, UTF_8)
        val response = transport.post(URI(TOKEN_URL), mapOf("Content-Type" to "application/x-www-form-urlencoded"),
            form, remaining(deadline))
        check(response.status == OK)
        val body = driverJson.readTree(response.body)
        val value = body.path("access_token").takeIf { it.isString }?.asString().orEmpty()
        val seconds = body.path("expires_in").asLong()
        check(value.isNotBlank() && value.length <= MAX_TOKEN_LENGTH && value.none(Char::isWhitespace))
        check(seconds in 1..TOKEN_SECONDS && body.path("token_type").asString().equals("Bearer", true))
        cached = AccessToken(value, now().plusSeconds(seconds))
        return value
    }

    private fun deliver(
        access: String, token: String, date: String, vehicleId: String, messageId: String, deadline: Long,
    ): Boolean {
        val body = driverJson.createObjectNode().apply {
            putObject("message").apply {
                put("token", token)
                putObject("notification").put("title", "미트박스 배송").put("body", "운영팀의 새 메시지가 있습니다.")
                putObject("data").put("type", "ops_message").put("date", date).put("vehicleId", vehicleId)
                    .put("messageId", messageId).put("title", "미트박스 배송").put("body", "운영팀의 새 메시지가 있습니다.")
            }
        }
        val response = transport.post(URI("https://fcm.googleapis.com/v1/projects/$projectId/messages:send"),
            mapOf("Authorization" to "Bearer $access", "Content-Type" to "application/json; charset=utf-8"),
            driverJson.writeValueAsString(body), remaining(deadline))
        if (response.status == UNAUTHORIZED) cached = null
        if (response.status != OK) return false
        val name = driverJson.readTree(response.body).path("name").asString("")
        return name.startsWith("projects/$projectId/messages/") && name.substringAfterLast('/').isNotBlank()
    }

    private fun credentials(): ServiceAccount {
        val path = Path.of(accountFile)
        require(path.isAbsolute && path.normalize() == path && Files.isRegularFile(path, NOFOLLOW_LINKS))
        var cursor: Path? = path
        while (cursor != null) {
            require(!Files.isSymbolicLink(cursor))
            cursor = cursor.parent
        }
        val bytes = Files.newInputStream(path).use { it.readNBytes(MAX_RESPONSE + 1) }
        check(bytes.size <= MAX_RESPONSE)
        val account = driverJson.readTree(bytes)
        check(account.path("type").asString() == "service_account")
        val email = account.path("client_email").asString("")
        check(email.isNotBlank() && email.length <= MAX_EMAIL_LENGTH && email.none(Char::isWhitespace))
        val pem = account.path("private_key").asString("")
        check(pem.startsWith("-----BEGIN PRIVATE KEY-----") && pem.trimEnd().endsWith("-----END PRIVATE KEY-----"))
        val encoded = pem.removePrefix("-----BEGIN PRIVATE KEY-----").trim()
            .removeSuffix("-----END PRIVATE KEY-----").filterNot(Char::isWhitespace)
        return ServiceAccount(email, Base64.getDecoder().decode(encoded))
    }

    private fun remaining(deadline: Long): Duration {
        val nanos = deadline - System.nanoTime()
        check(nanos > 0)
        return Duration.ofNanos(nanos)
    }

    private fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    private data class ServiceAccount(val email: String, val key: ByteArray)
    private data class AccessToken(val value: String, val expiresAt: Instant)

    companion object {
        private val PROJECT = Regex("[a-z][a-z0-9-]{4,61}[a-z0-9]")
        private val SEND_BUDGET = Duration.ofSeconds(4)
        private const val TOKEN_URL = "https://oauth2.googleapis.com/token"
        private const val SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
        private const val TOKEN_SECONDS = 3600L
        private const val REFRESH_MARGIN = 60L
        private const val MAX_TOKEN_LENGTH = 16_384
        private const val MAX_EMAIL_LENGTH = 320
        private const val MAX_RESPONSE = 65_536
        private const val OK = 200
        private const val UNAUTHORIZED = 401
    }
}

data class PushSummary(val status: String, val attempted: Int = 0, val sent: Int = 0, val failed: Int = 0)
data class FcmResponse(val status: Int, val body: String)
fun interface FcmTransport {
    fun post(uri: URI, headers: Map<String, String>, body: String, timeout: Duration): FcmResponse
}

class GoogleFcmTransport : FcmTransport {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
        .followRedirects(HttpClient.Redirect.NEVER).build()

    override fun post(uri: URI, headers: Map<String, String>, body: String, timeout: Duration): FcmResponse {
        val request = HttpRequest.newBuilder(uri).timeout(timeout).POST(HttpRequest.BodyPublishers.ofString(body))
        headers.forEach(request::header)
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString())
        check(response.body().length <= MAX_RESPONSE)
        return FcmResponse(response.statusCode(), response.body())
    }

    companion object { private const val MAX_RESPONSE = 65_536 }
}
