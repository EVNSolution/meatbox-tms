package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionUnavailableException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.beans.factory.ObjectProvider
import org.springframework.web.filter.OncePerRequestFilter

/** Fails closed: with no session verifier configured, /api/ops answers 503 instead of opening up. */
class OpsSessionFilter(private val verifier: ObjectProvider<SessionVerifier>) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.requestURI != BASE && !request.requestURI.startsWith("$BASE/")

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        try {
            val active = verifier.ifAvailable ?: throw SessionUnavailableException("SESSION_UNAVAILABLE")
            active.verify(request.getHeader("Cookie"))
            chain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (error: SessionUnavailableException) {
            writeProblem(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, error.errorCode)
        }
    }

    private companion object { const val BASE = "/api/ops" }
}
