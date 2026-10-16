package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.legacy.CustomRegions
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode

/** The operator's delivery zones: read what applies, replace it with an imported collection, or remove it. */
@RestController
@RequestMapping("/api/ops/regions")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class RegionsController(
    private val regions: CustomRegions,
    private val dispatch: DispatchStore,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    private val mapper = JsonMapper.builder().build()

    /** `custom` says whether the zones are the operator's or the prepared ones; `regions` is what applies now. */
    @GetMapping
    fun get(): ObjectNode {
        val view = regions.view()
        return mapper.createObjectNode().apply {
            put("revision", view.revision).put("custom", view.collection != null)
            set("regions", view.collection ?: dispatch.regions() ?: emptyCollection())
        }
    }

    /** Body `{revision, regions}`; a null `regions` removes the operator's zones and the prepared ones apply again. */
    @PutMapping
    fun save(request: HttpServletRequest): ObjectNode {
        val sameOrigin = origin.isNotEmpty() && request.getHeader("Origin") == origin
        if (!sameOrigin) throw fail(HttpStatus.FORBIDDEN, "ORIGIN_REQUIRED")
        val (revision, collection) = parse(request)
        val view = regions.save(revision, collection)
        log.info(
            "Changed delivery zones: custom={} zones={} revision={} by={}",
            view.collection != null, view.collection?.path("features")?.size() ?: 0, view.revision,
            request.getAttribute("meatbox.ops.user") ?: "unknown",
        )
        return mapper.createObjectNode().put("revision", view.revision).put("custom", view.collection != null)
    }

    private fun parse(request: HttpServletRequest): Pair<Long, JsonNode> {
        val bytes = request.inputStream.readNBytes(MAX_BODY + 1)
        val body = runCatching { mapper.readTree(bytes) as? ObjectNode }.getOrNull()
            ?.takeIf { it.size() == 2 && it.has("revision") && it.has("regions") }
        val revision = body?.path("revision")?.takeIf { it.isIntegralNumber && it.asLong() >= 0 }?.asLong()
        if (body == null || revision == null) throw fail(HttpStatus.BAD_REQUEST, "INVALID_INPUT")
        return revision to body.path("regions")
    }

    private fun fail(status: HttpStatus, code: String) = DispatchException(status.value(), code, code)

    private fun emptyCollection(): ObjectNode =
        mapper.createObjectNode().put("type", "FeatureCollection").apply { putArray("features") }

    private companion object {
        val log = LoggerFactory.getLogger(RegionsController::class.java)
        const val MAX_BODY = 14 * 1024 * 1024
    }
}
