package com.evnsolution.meatbox.auth

import com.evnsolution.meatbox.problemResponse
import jakarta.servlet.http.HttpServletRequest
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RestController

@RestController
@ConditionalOnProperty(prefix = "meatbox.auth", name = ["enabled"], havingValue = "true")
class AuthController(
    private val auth: AuthService,
    settings: AuthSettings,
) {
    private val parser = FormParser()
    private val policy = AuthRequestPolicy(settings, AccessRateLimiter())
    private val responses = AuthResponses(settings)

    @RequestMapping(path = ["/login"], method = [RequestMethod.POST])
    fun login(request: HttpServletRequest): ResponseEntity<String> = when {
        !policy.sameOrigin(request) -> responses.html(HttpStatus.FORBIDDEN, AuthHtml.originError())
        !policy.allow(request) -> responses.limited(policy.retryAfterSeconds())
        else -> loginForm(request)
    }

    private fun loginForm(request: HttpServletRequest): ResponseEntity<String> =
        runCatching { parser.parse(request) }.fold(
            onSuccess = ::authenticate,
            onFailure = { responses.html(HttpStatus.BAD_REQUEST, AuthHtml.loginError()) },
        )

    private fun authenticate(form: Map<String, String>): ResponseEntity<String> = try {
        val result = auth.login(LoginInput(form["username"].orEmpty(), form["password"].orEmpty()))
        responses.login(result, form["next"])
    } catch (_: AccessException) {
        responses.html(HttpStatus.UNAUTHORIZED, AuthHtml.loginError())
    } catch (_: AuthUnavailableException) {
        responses.html(HttpStatus.SERVICE_UNAVAILABLE, AuthHtml.unavailable())
    } catch (_: SessionUnavailableException) {
        responses.html(HttpStatus.SERVICE_UNAVAILABLE, AuthHtml.unavailable())
    }

    @RequestMapping(path = ["/dev/register"], method = [RequestMethod.POST])
    fun register(request: HttpServletRequest): ResponseEntity<String> = when {
        !policy.sameOrigin(request) -> responses.html(HttpStatus.FORBIDDEN, AuthHtml.originError())
        !policy.allow(request) -> responses.limited(policy.retryAfterSeconds())
        else -> registrationForm(request)
    }

    private fun registrationForm(request: HttpServletRequest): ResponseEntity<String> =
        runCatching { parser.parse(request) }.fold(
            onSuccess = ::createAccount,
            onFailure = { responses.html(HttpStatus.BAD_REQUEST, AuthHtml.registerError(null)) },
        )

    private fun createAccount(form: Map<String, String>): ResponseEntity<String> = try {
        auth.register(
            RegisterInput(
                form["invite"].orEmpty(),
                form["username"].orEmpty(),
                form["displayName"],
                form["password"].orEmpty(),
            ),
        )
        responses.redirect("/login?registered=1")
    } catch (error: AccessException) {
        responses.html(HttpStatus.BAD_REQUEST, AuthHtml.registerError(responses.fieldFor(error)))
    } catch (_: AuthUnavailableException) {
        responses.html(HttpStatus.SERVICE_UNAVAILABLE, AuthHtml.unavailable())
    }

    @RequestMapping(path = ["/logout"], method = [RequestMethod.POST])
    fun logout(request: HttpServletRequest): ResponseEntity<String> {
        if (!policy.sameOrigin(request)) return responses.html(HttpStatus.FORBIDDEN, AuthHtml.originError())
        auth.logout(AuthService.tokenFrom(request.getHeader(HttpHeaders.COOKIE)))
        return responses.logout()
    }

    @RequestMapping(path = ["/api/session"], method = [RequestMethod.GET, RequestMethod.HEAD])
    fun session(request: HttpServletRequest): ResponseEntity<Any> = try {
        val user = auth.session(AuthService.tokenFrom(request.getHeader(HttpHeaders.COOKIE)))
            ?: return problemResponse(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")
        ResponseEntity.ok(mapOf("user" to user))
    } catch (_: SessionUnavailableException) {
        problemResponse(HttpStatus.SERVICE_UNAVAILABLE.value(), "AUTH_UNAVAILABLE")
    }

}
