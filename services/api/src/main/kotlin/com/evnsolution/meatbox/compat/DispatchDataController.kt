package com.evnsolution.meatbox.compat

import jakarta.servlet.http.HttpServletRequest
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RestController
import java.nio.charset.StandardCharsets

@RestController
@ConditionalOnProperty(prefix = "meatbox.compat", name = ["enabled"], havingValue = "true")
class DispatchDataController(
    settings: CompatSettings,
) {
    private val reader = DispatchDataReader(settings)
    private val destinations = DestinationCatalogReader(settings)

    @RequestMapping("/api/dispatch-data/manifest", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun manifest(request: HttpServletRequest): ResponseEntity<ByteArray> =
        response(request, reader.manifest(request.getHeader(HttpHeaders.ACCEPT_ENCODING)))

    @RequestMapping("/api/dispatch-data/days/{date}", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun day(@PathVariable date: String, request: HttpServletRequest): ResponseEntity<ByteArray> =
        response(request, reader.day(date, request.getHeader(HttpHeaders.ACCEPT_ENCODING)))

    @RequestMapping("/api/dispatch-data/regions", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun regions(request: HttpServletRequest): ResponseEntity<ByteArray> =
        response(request, reader.regions(request.getHeader(HttpHeaders.ACCEPT_ENCODING)))

    @RequestMapping("/api/dispatch-data/destinations", method = [RequestMethod.GET, RequestMethod.HEAD])
    fun destinations(request: HttpServletRequest): ResponseEntity<ByteArray> {
        for (name in DESTINATION_PARAMETERS) {
            if ((request.getParameterValues(name)?.size ?: 0) > 1) throw queryInvalid()
        }
        val query = DestinationQuery(
            date = request.getParameter("date"),
            q = request.getParameter("q"),
            page = request.getParameter("page"),
            pageSize = request.getParameter("pageSize"),
        )
        return response(request, destinations.destinations(query, request.getHeader(HttpHeaders.ACCEPT_ENCODING)))
    }

    private fun response(request: HttpServletRequest, file: DispatchFile): ResponseEntity<ByteArray> {
        val headers = HttpHeaders()
        headers.contentType = MediaType("application", "json", StandardCharsets.UTF_8)
        headers.setETag(file.etag)
        headers.contentLength = file.bytes.size.toLong()
        file.contentEncoding?.let { headers.set(HttpHeaders.CONTENT_ENCODING, it) }
        if (file.varyAcceptEncoding) headers.set(HttpHeaders.VARY, HttpHeaders.ACCEPT_ENCODING)
        if (matches(request.getHeader(HttpHeaders.IF_NONE_MATCH), file.etag)) {
            headers.remove(HttpHeaders.CONTENT_LENGTH)
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).headers(headers).build()
        }
        val body = if (request.method == "HEAD") ByteArray(0) else file.bytes
        return ResponseEntity.status(HttpStatus.OK).headers(headers).body(body)
    }

    private fun matches(header: String?, etag: String): Boolean = header.orEmpty().split(',').any {
        val candidate = it.trim().removePrefix("W/")
        candidate == "*" || candidate == etag
    }

    companion object {
        private val DESTINATION_PARAMETERS = listOf("date", "q", "page", "pageSize")
    }
}
