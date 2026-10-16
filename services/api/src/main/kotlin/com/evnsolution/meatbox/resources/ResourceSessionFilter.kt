package com.evnsolution.meatbox.resources

import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionUnavailableException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.filter.OncePerRequestFilter

class ResourceSessionFilter(
    private val verifier: SessionVerifier,
    private val settings: ResourceSettings,
) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.requestURI != BASE && !request.requestURI.startsWith("$BASE/")

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        addResponseHeaders(response)
        try {
            verifier.verify(request.getHeader("Cookie"))
            filterChain.doFilter(request, response)
        } catch (_: LoginRequiredException) {
            writeProblem(response, HttpServletResponse.SC_UNAUTHORIZED, "LOGIN_REQUIRED")
        } catch (error: SessionUnavailableException) {
            writeProblem(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE, error.errorCode)
        }
    }

    fun requireSameOrigin(request: HttpServletRequest) {
        if (request.getHeader("Origin") != settings.publicOrigin.toString()) {
            throw ResourceException(
                HttpServletResponse.SC_FORBIDDEN,
                "ORIGIN_REQUIRED",
                "같은 출처에서 다시 시도해 주세요.",
            )
        }
    }

    private fun addResponseHeaders(response: HttpServletResponse) {
        response.setHeader(OWNER_HEADER, "kotlin")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
    }

    companion object {
        private const val BASE = "/api/resources"
        const val OWNER_HEADER = "X-Meatbox-Resource-Owner"
    }
}
