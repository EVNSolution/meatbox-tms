package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.compat.DispatchDataException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import java.net.URI

@RestController
@RequestMapping("/api/dispatch-data/days")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DispatchController(
    private val store: DispatchStore,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    private val parser = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()
    private val limits = mutableMapOf<String, Window>()

    init {
        val uri = URI(origin)
        require(uri.scheme == "https" || (uri.scheme == "http" && uri.host in setOf("127.0.0.1", "localhost", "[::1]")))
        require(uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null && uri.userInfo == null)
        require(!uri.host.isNullOrEmpty() && origin == "${uri.scheme}://${uri.rawAuthority}")
        require(uri.port == -1 || uri.port in 1..MAX_PORT)
    }

    @GetMapping("/{date}/state")
    fun state(@PathVariable date: String, request: HttpServletRequest): ResponseEntity<ByteArray> {
        val state = store.snapshot(date)
        val revision = state.path("revision").asLong()
        val today = state.path("dispatch").path("today").asString()
        val etag = "\"source-${store.boot}-$date-$revision-$today\""
        if (request.getHeader("If-None-Match") == etag) {
            return ResponseEntity.status(HttpServletResponse.SC_NOT_MODIFIED)
                .eTag(etag).header("Vary", "Accept-Encoding").build()
        }
        return json(request, state, etag)
    }

    @GetMapping("/{date}/commands/{requestId}")
    fun result(@PathVariable date: String, @PathVariable requestId: String, request: HttpServletRequest) =
        json(request, store.result(date, requestId))

    @PostMapping("/{date}/commands")
    fun command(@PathVariable date: String, request: HttpServletRequest): ResponseEntity<ByteArray> {
        if (request.getHeader("Origin") != origin) fail(HttpServletResponse.SC_FORBIDDEN, "ORIGIN_REQUIRED")
        limit(request.getAttribute("meatbox.username") as String)
        val body = body(request)
        if (body.path("type").asString("") !in COMMANDS) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        return json(request, store.command(date, body))
    }

    private fun body(request: HttpServletRequest): ObjectNode {
        val isJson = request.contentType?.substringBefore(';')?.trim()?.equals("application/json", true) == true
        if (!isJson) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = request.inputStream.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_BODY) {
                fail(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "COMMAND_TOO_LARGE")
            }
            output.write(buffer, 0, count)
        }
        return runCatching { parser.readTree(output.toByteArray()) as? ObjectNode }.getOrNull()
            ?: fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
    }

    @Synchronized
    private fun limit(username: String) {
        val now = System.currentTimeMillis()
        limits.entries.removeIf { it.value.until <= now }
        if (username !in limits && limits.size >= MAX_USERS) {
            fail(HttpServletResponse.SC_SERVICE_UNAVAILABLE, "SOURCE_OPERATIONS_CAPACITY")
        }
        val window = limits.getOrPut(username) { Window(now + WINDOW_MILLIS) }
        if (++window.count > MAX_COMMANDS) fail(HttpStatus.TOO_MANY_REQUESTS.value(), "COMMAND_RATE_LIMITED")
    }

    private fun json(request: HttpServletRequest, value: ObjectNode, etag: String? = null): ResponseEntity<ByteArray> {
        var bytes = parser.writeValueAsBytes(value)
        val response = ResponseEntity.ok()
            .header("Content-Type", "application/json; charset=utf-8").header("Vary", "Accept-Encoding")
        if (etag != null) response.eTag(etag)
        if (acceptsGzip(request.getHeader("Accept-Encoding"))) {
            val output = ByteArrayOutputStream()
            GZIPOutputStream(output).use { it.write(bytes) }
            bytes = output.toByteArray()
            response.header("Content-Encoding", "gzip")
        }
        return response.body(bytes)
    }

    private fun acceptsGzip(value: String?): Boolean {
        val choices = value.orEmpty().split(',').map { token ->
            val parts = token.trim().split(';').map(String::trim)
            val quality = parts.drop(1).firstOrNull { it.startsWith("q=", true) }
                ?.substringAfter('=')?.toDoubleOrNull() ?: 1.0
            parts.firstOrNull().orEmpty() to quality
        }
        val gzip = choices.firstOrNull { it.first.equals("gzip", true) } ?: choices.firstOrNull { it.first == "*" }
        return gzip?.second?.let { it > 0 } == true
    }

    private fun fail(status: Int, code: String): Nothing = throw DispatchException(status, code, code)
    private data class Window(val until: Long, var count: Int = 0)
    companion object {
        private const val MAX_PORT = 65_535
        private const val WINDOW_MILLIS = 60_000L
        private const val MAX_COMMANDS = 120
        private const val MAX_BODY = 128 * 1024
        private const val MAX_USERS = 4096
        private val COMMANDS = setOf(
            "calculate_dispatch", "reassign", "publish_dispatch",
            "begin_dispatch_revision", "discard_dispatch_revision", "set_route_order",
            "start_route", "arrive_stop", "complete_stop",
        )
    }
}
