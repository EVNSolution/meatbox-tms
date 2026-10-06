package com.evnsolution.meatbox.auth

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import java.net.URI
import java.time.Duration

internal class AuthRequestPolicy(
    private val settings: AuthSettings,
    private val rateLimiter: AccessRateLimiter,
) {
    fun sameOrigin(request: HttpServletRequest): Boolean =
        request.getHeader(HttpHeaders.ORIGIN) == settings.publicOrigin.toString()

    fun allow(request: HttpServletRequest): Boolean = rateLimiter.allow(clientKey(request))

    fun retryAfterSeconds(): Long = rateLimiter.retryAfterSeconds()

    private fun clientKey(request: HttpServletRequest): String {
        val peer = request.remoteAddr.orEmpty()
        val forwarded = request.getHeader(TRUSTED_CLIENT_HEADER)
        val trustedForwarded = peer in LOOPBACK_PEERS && forwarded?.matches(CLIENT_ADDRESS) == true
        return if (trustedForwarded) requireNotNull(forwarded) else peer
    }

    companion object {
        const val TRUSTED_CLIENT_HEADER = "X-Meatbox-Client-Address"
        private val LOOPBACK_PEERS = setOf("127.0.0.1", "0:0:0:0:0:0:0:1", "::1")
        private val CLIENT_ADDRESS = Regex("^[0-9A-Fa-f:.]{1,45}$")
    }
}

internal class AuthResponses(private val settings: AuthSettings) {
    fun login(result: LoginResult, next: String?): ResponseEntity<String> = ResponseEntity.status(HttpStatus.SEE_OTHER)
        .header(HttpHeaders.LOCATION, safeNext(next))
        .header(HttpHeaders.SET_COOKIE, sessionCookie(result))
        .contentType(MediaType.TEXT_HTML)
        .body("")

    fun logout(): ResponseEntity<String> = ResponseEntity.status(HttpStatus.SEE_OTHER)
        .header(HttpHeaders.LOCATION, "/login")
        .header(HttpHeaders.SET_COOKIE, expiredCookie())
        .contentType(MediaType.TEXT_HTML)
        .body("")

    fun redirect(location: String): ResponseEntity<String> = ResponseEntity.status(HttpStatus.SEE_OTHER)
        .header(HttpHeaders.LOCATION, location)
        .contentType(MediaType.TEXT_HTML)
        .body("")

    fun limited(retryAfterSeconds: Long): ResponseEntity<String> = ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
        .header(HttpHeaders.RETRY_AFTER, retryAfterSeconds.toString())
        .contentType(MediaType.TEXT_HTML)
        .body(AuthHtml.limited())

    fun html(status: HttpStatus, body: String): ResponseEntity<String> = ResponseEntity.status(status)
        .contentType(MediaType.TEXT_HTML)
        .body(body)

    fun fieldFor(error: AccessException): Pair<String, String>? {
        val field = error.field ?: ERROR_FIELDS[error.code]
        val message = when {
            error.code == "USERNAME_TAKEN" -> "이미 사용 중인 아이디입니다."
            error.code == "INVALID_INVITE" -> "초대 코드가 유효하지 않거나 이미 사용되었습니다."
            else -> FIELD_MESSAGES[field]
        }
        return if (field == null || message == null) null else field to message
    }

    private fun sessionCookie(result: LoginResult): String = buildString {
        append(AuthService.COOKIE_NAME).append('=').append(result.token)
        val maxAge = Duration.ofMillis(result.expiresAt - System.currentTimeMillis()).seconds.coerceAtLeast(0)
        append("; Max-Age=").append(maxAge).append(COOKIE_ATTRIBUTES)
        if (settings.publicOrigin.scheme == HTTPS_SCHEME) append("; Secure")
    }

    private fun expiredCookie(): String = buildString {
        append(AuthService.COOKIE_NAME).append("=; Max-Age=0").append(COOKIE_ATTRIBUTES)
        if (settings.publicOrigin.scheme == HTTPS_SCHEME) append("; Secure")
    }

    private fun safeNext(value: String?): String {
        val uri = value?.takeUnless(INVALID_NEXT::containsMatchIn)?.let { runCatching { URI(it) }.getOrNull() }
        return if (uri?.let(::isProductUri) == true) requireNotNull(value) else "/"
    }

    private fun isProductUri(uri: URI): Boolean =
        !uri.isAbsolute && uri.rawAuthority == null && uri.rawPath?.let(PRODUCT_PATH::matches) == true

    companion object {
        private const val HTTPS_SCHEME = "https"
        private const val COOKIE_ATTRIBUTES = "; Path=/; HttpOnly; SameSite=Strict"
        private val ERROR_FIELDS = mapOf("USERNAME_TAKEN" to "username", "INVALID_INVITE" to "invite")
        private val FIELD_MESSAGES = mapOf(
            "username" to "영문 또는 숫자로 시작하는 3~40자로 입력해 주세요.",
            "password" to "비밀번호를 8~128자로 입력해 주세요.",
            "displayName" to "표시 이름은 제어 문자를 제외한 80자 이내로 입력해 주세요.",
        )
        private val INVALID_NEXT = Regex("[\\\\\\r\\n]")
        private val PRODUCT_PATH = Regex("^/(?:$|(?:ui-layout|combined)(?:/|$)).*")
    }
}
