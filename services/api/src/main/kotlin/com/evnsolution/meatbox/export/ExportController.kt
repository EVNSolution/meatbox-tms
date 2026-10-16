package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.ops.OpsSessionFilter
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.core.io.FileSystemResource
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode

private const val UNAVAILABLE = 503
private const val BAD_REQUEST = 400
private val BODY_FIELDS = setOf("from", "to", "include")
private val audit = LoggerFactory.getLogger("com.evnsolution.meatbox.export.Audit")

/** The CLI archive, for a signed-in operator. It holds customer phone numbers and entrance codes. */
@RestController
@RequestMapping("/api/ops/export")
class ExportController(private val jobs: ObjectProvider<ExportJobs>) {
    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun start(@RequestBody(required = false) body: ObjectNode?, request: HttpServletRequest): JsonNode =
        view(jobs().start(parse(body), user(request)))

    @GetMapping
    fun list(): JsonNode = exportJson.createObjectNode().also { out ->
        val list = out.putArray("exports")
        jobs().list().forEach { list.add(view(it)) }
    }

    @GetMapping("/{jobId}")
    fun status(@PathVariable jobId: String): JsonNode = view(jobs().get(jobId))

    @GetMapping("/{jobId}/download")
    fun download(@PathVariable jobId: String, request: HttpServletRequest): ResponseEntity<FileSystemResource> {
        val file = jobs().archive(jobId)
        audit.info("EXPORT_DOWNLOAD job={} user={}", jobId, user(request))
        val name = ContentDisposition.attachment().filename("meatbox-export-$jobId.zip").build()
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("application/zip"))
            .header(HttpHeaders.CONTENT_DISPOSITION, name.toString()).body(FileSystemResource(file))
    }

    private fun jobs(): ExportJobs =
        jobs.ifAvailable ?: throw DispatchException(UNAVAILABLE, "EXPORT_UNAVAILABLE", "EXPORT_UNAVAILABLE")

    private fun user(request: HttpServletRequest) =
        request.getAttribute(OpsSessionFilter.USER_ATTRIBUTE) as? String ?: "unknown"

    private fun parse(body: ObjectNode?): ExportRequest {
        if (body == null) return ExportRequest.of(null, null, null)
        if (!BODY_FIELDS.containsAll(body.propertyNames())) {
            throw DispatchException(BAD_REQUEST, "INVALID_EXPORT", "Unknown field.")
        }
        fun text(name: String) = body.get(name)?.takeUnless(JsonNode::isNull)?.also {
            if (!it.isString) throw DispatchException(BAD_REQUEST, "INVALID_EXPORT", "$name must be text.")
        }?.asString()
        val include = body.get("include")?.takeUnless(JsonNode::isNull)?.also {
            if (!it.isArray || !it.all(JsonNode::isString)) {
                throw DispatchException(BAD_REQUEST, "INVALID_EXPORT", "include must list group names.")
            }
        }?.toList()?.map { it.asString() }
        return ExportRequest.of(text("from"), text("to"), include)
    }

    private fun view(job: ExportJob): ObjectNode = exportJson.createObjectNode().apply {
        put("jobId", job.id).put("state", job.state).put("requestedBy", job.requestedBy)
        put("createdAt", job.createdAt.toString())
        putObject("range").put("from", job.from).put("to", job.to)
        putArray("include").also { list -> job.include.forEach(list::add) }
        job.finishedAt?.let { put("finishedAt", it.toString()) }
        job.bytes?.let { put("bytes", it) }
        job.sha256?.let { put("sha256", it) }
        job.error?.let { put("error", it) }
        if (job.state == "done") put("download", "/api/ops/export/${job.id}/download")
    }
}
