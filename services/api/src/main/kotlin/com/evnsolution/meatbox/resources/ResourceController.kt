package com.evnsolution.meatbox.resources

import jakarta.servlet.http.HttpServletRequest
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.io.ByteArrayOutputStream
import java.math.BigDecimal

@RestController
@RequestMapping("/api/resources")
@ConditionalOnProperty(prefix = "meatbox.resources", name = ["enabled"], havingValue = "true")
class ResourceController(
    private val store: ResourceStore,
    private val sessionFilter: ResourceSessionFilter,
) {
    private val parser = ResourceRequestParser()

    @GetMapping
    fun snapshot(): ResourceSnapshot = store.snapshot()

    @PostMapping("/region-codes")
    fun createRegionCode(request: HttpServletRequest): ResourceSnapshot {
        sessionFilter.requireSameOrigin(request)
        val body = parser.body(request, setOf("revision", "code"))
        return store.createRegionCode(parser.revision(body["revision"]), parser.regionCode(body["code"]))
    }

    @PatchMapping("/region-codes/{code}")
    fun renameRegionCode(
        @PathVariable code: String,
        request: HttpServletRequest,
    ): ResourceSnapshot {
        sessionFilter.requireSameOrigin(request)
        val body = parser.body(request, setOf("revision", "code"))
        return store.renameRegionCode(parser.revision(body["revision"]), code, parser.regionCode(body["code"]))
    }

    @PatchMapping("/vehicles")
    fun assignVehicles(request: HttpServletRequest): ResourceSnapshot {
        sessionFilter.requireSameOrigin(request)
        val body = parser.body(request, setOf("revision", "assignments"))
        return store.assignVehicles(parser.revision(body["revision"]), parser.assignments(body["assignments"]))
    }

    @PatchMapping("/vehicles/{id}")
    fun assignVehicle(
        @PathVariable id: String,
        request: HttpServletRequest,
    ): ResourceSnapshot {
        sessionFilter.requireSameOrigin(request)
        val body = parser.body(request, setOf("revision", "regionCode"))
        return store.assignVehicle(parser.revision(body["revision"]), id, parser.nullableRegionCode(body["regionCode"]))
    }
}

@Suppress("TooManyFunctions")
private class ResourceRequestParser {
    private val mapper = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .build()

    fun body(request: HttpServletRequest, keys: Set<String>): JsonNode {
        val contentType = request.contentType?.substringBefore(';')?.trim()
        val root = if (contentType?.equals(MediaType.APPLICATION_JSON_VALUE, true) == true) {
            parseJson(readLimited(request))
        } else {
            null
        }
        if (root == null || !root.isObject || root.properties().map { it.key }.toSet() != keys) invalidInput()
        return root
    }

    private fun readLimited(request: HttpServletRequest): ByteArray {
        val input = request.inputStream
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_BODY_BYTES) invalidJson()
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun parseJson(bytes: ByteArray): JsonNode = runCatching { mapper.readTree(bytes) }
        .getOrElse { invalidJson() }

    fun revision(node: JsonNode?): Long {
        if (node == null || !node.isNumber) invalidRevision()
        val value = runCatching { node.decimalValue() }.getOrElse { invalidRevision() }
        val isInvalid = value.stripTrailingZeros().scale() > 0 ||
            value < BigDecimal.ZERO || value > MAX_SAFE_INTEGER
        if (isInvalid) invalidRevision()
        return value.longValueExact()
    }

    fun regionCode(node: JsonNode?): String {
        if (node == null || !node.isString) invalidRegionCode()
        return node.asString()
    }

    fun nullableRegionCode(node: JsonNode?): String? {
        if (node == null || node.isNull) return null
        return regionCode(node)
    }

    @Suppress("ComplexCondition")
    fun assignments(node: JsonNode?): List<VehicleAssignment> {
        if (node == null || !node.isArray) {
            throw ResourceException(
                HttpStatus.BAD_REQUEST.value(),
                "INVALID_ASSIGNMENTS",
                "변경할 차량을 1~1000개 선택해 주세요.",
            )
        }
        return buildList {
            for (item in node) {
                if (!item.isObject || item.properties().map { it.key }.toSet() != ASSIGNMENT_KEYS) {
                    invalidAssignments()
                }
                val id = item["id"]
                val codeNode = item["regionCode"]
                if (id == null || !id.isString || codeNode == null) {
                    invalidAssignments()
                }
                add(VehicleAssignment(id.asString(), if (codeNode.isNull) null else regionCode(codeNode)))
            }
        }
    }

    private fun invalidInput(): Nothing = throw ResourceException(
        HttpStatus.BAD_REQUEST.value(),
        "INVALID_INPUT",
        "입력값을 확인해 주세요.",
    )

    private fun invalidJson(): Nothing = throw ResourceException(HttpStatus.BAD_REQUEST.value(), "INVALID_JSON", "")

    private fun invalidRevision(): Nothing = throw ResourceException(
        HttpStatus.BAD_REQUEST.value(),
        "INVALID_REVISION",
        "최신 자원 정보를 다시 불러와 주세요.",
    )

    private fun invalidAssignments(): Nothing = throw ResourceException(
        HttpStatus.BAD_REQUEST.value(),
        "INVALID_ASSIGNMENTS",
        "차량 목록에 중복되거나 잘못된 항목이 있습니다.",
    )

    private fun invalidRegionCode(): Nothing = throw ResourceException(
        HttpStatus.BAD_REQUEST.value(),
        "INVALID_REGION_CODE",
        "지역 코드는 영문자로 시작하고 영문·숫자만 사용할 수 있습니다.",
    )

    companion object {
        private const val MAX_BODY_BYTES = 256 * 1024
        private val MAX_SAFE_INTEGER = BigDecimal("9007199254740991")
        private val ASSIGNMENT_KEYS = setOf("id", "regionCode")
    }
}
