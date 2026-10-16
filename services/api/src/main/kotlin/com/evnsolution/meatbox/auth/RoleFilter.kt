package com.evnsolution.meatbox.auth

import com.evnsolution.meatbox.writeProblem
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.beans.factory.ObjectProvider
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

/**
 * The one place that decides which role may call which API path. A request without a valid session passes on, so
 * that the module's own session filter answers it (401, or 503 when sessions are unavailable). Every path that
 * [RoleAccess] does not name belongs to operators, so a new controller starts closed to drivers.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
class RoleFilter(private val verifier: ObjectProvider<SessionVerifier>) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        !request.requestURI.startsWith("/api/") || RoleAccess.usesToken(request.method, request.requestURI)

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        val source = verifier.ifAvailable?.takeIf { it.knowsRoles }
        val identity = try {
            source?.identify(request.getHeader("Cookie"))
        } catch (_: LoginRequiredException) {
            null
        } catch (_: SessionUnavailableException) {
            null
        }
        if (identity != null && !RoleAccess.allows(identity.role, request.requestURI)) {
            response.setHeader("Cache-Control", "no-store")
            response.setHeader("X-Content-Type-Options", "nosniff")
            writeProblem(response, HttpServletResponse.SC_FORBIDDEN, "ROLE_FORBIDDEN")
            return
        }
        identity?.role?.let { request.setAttribute(ROLE_ATTRIBUTE, it.wire) }
        chain.doFilter(request, response)
    }

    companion object {
        /** The role of the signed-in user, set here for the controllers that bind a driver to their own vehicles. */
        const val ROLE_ATTRIBUTE = "meatbox.role"
    }
}

object RoleAccess {
    private val DRIVER_PATH = Regex("^/api/dispatch-data/days/[^/]+/driver(?:/.*)?$")
    private const val SESSION_PATH = "/api/session"
    private const val TOKEN_PREFIX = "/api/meatbox"
    private const val TEMPERATURE_PATH = "/api/telemetry/temperature"

    /** Paths that a bearer token guards instead of a session; the roles do not apply. */
    fun usesToken(method: String, path: String): Boolean =
        path == TOKEN_PREFIX || path.startsWith("$TOKEN_PREFIX/") || (method == "POST" && path == TEMPERATURE_PATH)

    fun allows(role: Role?, path: String): Boolean = when {
        path == SESSION_PATH -> true
        role == Role.OPS -> true
        role == Role.DRIVER -> DRIVER_PATH.matches(path)
        else -> false
    }
}
