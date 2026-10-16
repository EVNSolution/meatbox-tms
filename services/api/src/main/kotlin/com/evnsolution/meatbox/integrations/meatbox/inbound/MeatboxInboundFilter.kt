package com.evnsolution.meatbox.integrations.meatbox.inbound

import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter
import java.security.MessageDigest

/**
 * Meatbox calls the `/api/meatbox` paths with a shared Bearer token instead of a login session. The bean exists
 * only when `MEATBOX_INBOUND_TOKEN` is set, so an unset token leaves the paths unmapped (404).
 */
class MeatboxInboundFilter(
    token: String,
    private val path: Regex = PATH,
    private val code: String = "INBOUND_UNAUTHORIZED",
) : OncePerRequestFilter() {
    private val expected = digest(token)

    init {
        require(token.length >= MIN_TOKEN_LENGTH) {
            "the Bearer token must have at least $MIN_TOKEN_LENGTH characters"
        }
    }

    override fun shouldNotFilter(request: HttpServletRequest): Boolean = !path.matches(request.requestURI)

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        val header = request.getHeader("Authorization").orEmpty()
        val given = header.takeIf { it.startsWith(BEARER, ignoreCase = true) }?.substring(BEARER.length)?.trim()
        // Compare digests so the check takes the same time for any input.
        if (given == null || !MessageDigest.isEqual(expected, digest(given))) {
            response.setHeader("WWW-Authenticate", "Bearer")
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, code)
            return
        }
        chain.doFilter(request, response)
    }

    private fun digest(value: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())

    private companion object {
        const val MIN_TOKEN_LENGTH = 16
        const val BEARER = "Bearer "
        val PATH = Regex("^/api/meatbox(?:/.*)?$")
    }
}
