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
            request.setAttribute(USER_ATTRIBUTE, active.verify(request.getHeader("Cookie")))
            chain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (error: SessionUnavailableException) {
            writeProblem(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, error.errorCode)
        }
    }

    companion object {
        /** The verified user name, for the audit line of endpoints that hand out personal data. */
        const val USER_ATTRIBUTE = "meatbox.ops.user"
        private const val BASE = "/api/ops"
    }
}
