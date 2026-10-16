package com.evnsolution.meatbox.legacy

import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionUnavailableException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

@Component
@ConditionalOnProperty(prefix = "meatbox.compat", name = ["enabled"], havingValue = "true")
class LegacySessionFilter(
    private val verifier: SessionVerifier,
) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.method !in METHODS || !matchesReadEndpoint(request.requestURI)

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        response.setHeader(SOURCE_READER_HEADER, "kotlin")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        try {
            verifier.verify(request.getHeader("Cookie"))
            filterChain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (error: SessionUnavailableException) {
            writeProblem(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, error.errorCode)
        }
    }

    private fun matchesReadEndpoint(path: String): Boolean =
        path == "$BASE/manifest" || path == "$BASE/regions" || path == "$BASE/destinations" || DAY_PATH.matches(path)

    companion object {
        private const val BASE = "/api/dispatch-data"
        const val SOURCE_READER_HEADER = "X-Meatbox-Source-Reader"
        private val DAY_PATH = Regex("^$BASE/days/[^/]+$")
        private val METHODS = setOf("GET", "HEAD")
    }
}
