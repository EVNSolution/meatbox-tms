package com.evnsolution.meatbox

import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.resources.ResourceException
import jakarta.servlet.RequestDispatcher
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.boot.webmvc.error.ErrorController
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.request.WebRequest
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler
import tools.jackson.databind.json.JsonMapper
import java.util.Locale

private const val MAX_DETAIL = 300
private const val RETRY_AFTER_SECONDS = "60"
private const val INTERNAL_ERROR = "INTERNAL_ERROR"
private const val INTERNAL_DETAIL = "The server could not process the request."
private val mapper: JsonMapper = JsonMapper.builder().build()
private val log = LoggerFactory.getLogger("com.evnsolution.meatbox.Problem")

/** The one place that builds an RFC 9457 body. Controllers, advice and filters all use it. */
fun problemBody(status: Int, code: String, detail: String? = null): Map<String, Any> {
    val title = code.lowercase(Locale.ROOT).replace('_', ' ').replaceFirstChar { it.uppercase(Locale.ROOT) }
    val text = detail?.take(MAX_DETAIL)
    return buildMap {
        put("type", "about:blank")
        put("title", title)
        put("status", status)
        put("detail", text ?: title)
        put("code", code)
        // Compat: the web client still reads "error" and "message". Remove both once it reads "code" and "detail".
        put("error", code)
        if (text != null) put("message", text)
    }
}

fun problemResponse(status: Int, code: String, detail: String? = null): ResponseEntity<Any> {
    val builder = ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
    if (status == HttpStatus.TOO_MANY_REQUESTS.value()) builder.header(HttpHeaders.RETRY_AFTER, RETRY_AFTER_SECONDS)
    return builder.body(problemBody(status, code, detail))
}

/** Servlet filters run outside Spring MVC, so they write the same body by hand. */
fun writeProblem(response: HttpServletResponse, status: Int, code: String, detail: String? = null) {
    response.status = status
    if (status == HttpStatus.TOO_MANY_REQUESTS.value()) response.setHeader(HttpHeaders.RETRY_AFTER, RETRY_AFTER_SECONDS)
    response.contentType = MediaType.APPLICATION_PROBLEM_JSON_VALUE
    response.characterEncoding = Charsets.UTF_8.name()
    response.outputStream.write(mapper.writeValueAsBytes(problemBody(status, code, detail)))
}

private fun codeOf(status: HttpStatusCode): String =
    if (status.value() == HttpStatus.INTERNAL_SERVER_ERROR.value()) INTERNAL_ERROR
    else HttpStatus.resolve(status.value())?.name ?: "HTTP_${status.value()}"

@RestControllerAdvice
class ProblemExceptionHandler(private val alerts: ErrorAlerts) : ResponseEntityExceptionHandler() {
    @ExceptionHandler(DispatchException::class)
    fun dispatch(error: DispatchException): ResponseEntity<Any> {
        if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR.value()) {
            alerts.report("dispatch", error.code, error.message)
        }
        return problemResponse(error.status, error.code, error.message)
    }

    @ExceptionHandler(DispatchDataException::class)
    fun source(error: DispatchDataException) = problemResponse(error.status.value(), error.code)

    @ExceptionHandler(ResourceException::class)
    fun resource(error: ResourceException) = problemResponse(error.status, error.code, error.message)

    @ExceptionHandler(Exception::class)
    fun unexpected(error: Exception): ResponseEntity<Any> {
        log.error("Unhandled exception", error)
        // Class name only: messages and stacks can carry paths or request data.
        alerts.report("server", INTERNAL_ERROR, error.javaClass.simpleName)
        return problemResponse(HttpStatus.INTERNAL_SERVER_ERROR.value(), INTERNAL_ERROR, INTERNAL_DETAIL)
    }

    /** Spring's own errors (404, 405, 415, unreadable body) reuse its exception mapping but get our body. */
    override fun handleExceptionInternal(
        ex: Exception,
        body: Any?,
        headers: HttpHeaders,
        statusCode: HttpStatusCode,
        request: WebRequest,
    ): ResponseEntity<Any>? {
        val out = HttpHeaders()
        out.putAll(headers)
        out.contentType = MediaType.APPLICATION_PROBLEM_JSON
        val reason = HttpStatus.resolve(statusCode.value())?.reasonPhrase
        return ResponseEntity(problemBody(statusCode.value(), codeOf(statusCode), reason), out, statusCode)
    }
}

/** Replaces Boot's /error page, which would otherwise answer container-level errors in a different shape. */
@RestController
class ProblemErrorController : ErrorController {
    @RequestMapping("/error")
    fun error(request: HttpServletRequest): ResponseEntity<Any> {
        val status = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE) as? Int
            ?: HttpStatus.INTERNAL_SERVER_ERROR.value()
        val code = codeOf(HttpStatusCode.valueOf(status))
        val detail = if (code == INTERNAL_ERROR) INTERNAL_DETAIL else HttpStatus.resolve(status)?.reasonPhrase
        return problemResponse(status, code, detail)
    }
}
