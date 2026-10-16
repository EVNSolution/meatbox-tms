package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.legacy.LoginRequiredException
import com.evnsolution.meatbox.legacy.SessionUnavailableException
import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter

/** Reading the stored measurements needs the login session. The terminal's POST uses the Bearer token instead. */
class TelemetrySessionFilter(private val verifier: SessionVerifier) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.method !in setOf("GET", "HEAD") || !PATH.matches(request.requestURI)

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        try {
            request.setAttribute("meatbox.username", verifier.verify(request.getHeader("Cookie")))
            chain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (_: SessionUnavailableException) {
            writeProblem(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, "SESSION_UNAVAILABLE")
        }
    }

    companion object { private val PATH = Regex("^/api/telemetry(?:/.*)?$") }
}
