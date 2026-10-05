package com.evnsolution.meatbox.auth

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

@Component
@ConditionalOnProperty(prefix = "meatbox.auth", name = ["enabled"], havingValue = "true")
class AuthResponseFilter : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean = request.requestURI !in PATHS

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        response.setHeader(AUTH_OWNER_HEADER, "kotlin")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.setHeader("X-Frame-Options", "DENY")
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
        response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        filterChain.doFilter(request, response)
    }

    companion object {
        const val AUTH_OWNER_HEADER = "X-Meatbox-Auth-Owner"
        private val PATHS = setOf("/login", "/dev/register", "/logout", "/api/session")
        private const val CONTENT_SECURITY_POLICY =
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    }
}
