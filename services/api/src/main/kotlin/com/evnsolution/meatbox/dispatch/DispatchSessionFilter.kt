package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.compat.LoginRequiredException
import com.evnsolution.meatbox.compat.SessionUnavailableException
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter

class DispatchSessionFilter(private val verifier: SessionVerifier) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean = !PATH.matches(request.requestURI)

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        response.setHeader("X-Meatbox-Dispatch-Owner", "kotlin")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        try {
            request.setAttribute("meatbox.username", verifier.verify(request.getHeader("Cookie")))
            chain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            fail(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (_: SessionUnavailableException) {
            fail(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, "SESSION_UNAVAILABLE")
        }
    }

    private fun fail(response: HttpServletResponse, status: Int, code: String) {
        response.status = status
        response.contentType = "application/json"
        response.writer.write("{\"error\":\"$code\"}")
    }

    companion object { private val PATH = Regex("^/api/dispatch-data/days/[^/]+/(?:state|commands|driver)(?:/.*)?$") }
}
