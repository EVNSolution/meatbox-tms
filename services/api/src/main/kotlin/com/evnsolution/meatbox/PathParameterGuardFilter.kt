package com.evnsolution.meatbox

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

/**
 * The session filters compare the raw request URI, but Spring MVC drops path parameters (";x=1")
 * before it chooses a handler. A request such as "/api/resources;x=1" would skip the session
 * check and still reach the controller. No endpoint uses path parameters, so reject them first.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class PathParameterGuardFilter : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        val uri = request.requestURI
        if (';' !in uri && !uri.contains(ENCODED_SEMICOLON, ignoreCase = true)) {
            filterChain.doFilter(request, response)
            return
        }
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("X-Content-Type-Options", "nosniff")
        writeProblem(response, HttpServletResponse.SC_BAD_REQUEST, "INVALID_PATH")
    }

    private companion object {
        const val ENCODED_SEMICOLON = "%3b"
    }
}
