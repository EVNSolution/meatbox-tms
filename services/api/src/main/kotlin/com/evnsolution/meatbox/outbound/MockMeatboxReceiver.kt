package com.evnsolution.meatbox.outbound

import com.evnsolution.meatbox.dispatch.DispatchException
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.time.Instant

/**
 * TEST ONLY. Stands in for Meatbox until its API exists (contract 5, 7.4): checks the required keys of contract 3,
 * answers `202 {"accepted":true}` and keeps the last [MAX_KEPT] messages for `GET received`. It has no session
 * check, so it exists only when `meatbox.mock-receiver.enabled=true`, which no production configuration sets.
 */
@RestController
@RequestMapping("/mock/meatbox")
@ConditionalOnProperty(prefix = "meatbox.mock-receiver", name = ["enabled"], havingValue = "true")
class MockMeatboxReceiver {
    private val received = ArrayDeque<ObjectNode>()

    // The sender posts to `{base}/tms/<kind>`, so the mock also answers there.
    // Set the base URL to `<origin>/mock/meatbox`.
    @PostMapping("/delivery-status", "/tms/delivery-status")
    fun deliveryStatus(@RequestHeader(KEY, required = false) key: String?, @RequestBody body: JsonNode) =
        accept("delivery-status", key, body)

    @PostMapping("/eta", "/tms/eta")
    fun eta(@RequestHeader(KEY, required = false) key: String?, @RequestBody body: JsonNode) = accept("eta", key, body)

    @PostMapping("/temperature", "/tms/temperature")
    fun temperature(@RequestHeader(KEY, required = false) key: String?, @RequestBody body: JsonNode) =
        accept("temperature", key, body)

    @GetMapping("/received")
    fun received(@RequestParam(required = false) kind: String?): ObjectNode {
        if (kind != null && kind !in SHAPES) throw reject("INVALID_KIND")
        return mapper.createObjectNode().set("messages", mapper.createArrayNode().apply {
            val kept = synchronized(received) { received.filter { kind == null || it.path("kind").asString() == kind } }
            kept.forEach(::add)
        })
    }

    private fun accept(kind: String, key: String?, body: JsonNode): ResponseEntity<Map<String, Boolean>> {
        problem(kind, key, body)?.let { throw reject(it) }
        val id = key.orEmpty()
        synchronized(received) {
            // Same key twice is one message, as a real idempotent receiver would treat it.
            if (received.none { it.path("idempotencyKey").asString() == id }) {
                received.addLast(mapper.createObjectNode().put("kind", kind).put("idempotencyKey", id)
                    .put("receivedAt", Instant.now().toString()).set("body", body))
                if (received.size > MAX_KEPT) received.removeFirst()
            }
        }
        return ResponseEntity.accepted().body(mapOf("accepted" to true))
    }

    /** The error code of the first thing wrong with the request, or null when it is a valid contract message. */
    private fun problem(kind: String, key: String?, body: JsonNode): String? {
        val shape = SHAPES.getValue(kind)
        val fields = body as? ObjectNode
        val valid = fields != null &&
            shape.strings.all { fields.path(it).isString && fields.path(it).asString().isNotBlank() } &&
            shape.arrays.all { fields.path(it).isArray } &&
            (shape.allowed == null || fields.path(shape.allowed.first).asString() in shape.allowed.second)
        return when {
            key.isNullOrBlank() -> "IDEMPOTENCY_KEY_REQUIRED"
            !valid -> "INVALID_BODY"
            fields?.path("messageId")?.asString() != key -> "IDEMPOTENCY_KEY_MISMATCH"
            else -> null
        }
    }

    private fun reject(code: String) = DispatchException(BAD_REQUEST, code, code)

    private class Shape(val strings: List<String>, val arrays: List<String>, val allowed: Pair<String, Set<String>>?)

    private companion object {
        const val KEY = "Idempotency-Key"
        const val MAX_KEPT = 200
        const val BAD_REQUEST = 400
        val mapper: JsonMapper = JsonMapper.builder().build()
        val SHAPES = mapOf(
            "delivery-status" to Shape(
                listOf("messageId", "orderId", "status", "occurredAt", "vehicleId"), emptyList(),
                "status" to setOf("dispatched", "departed", "arriving", "delivered", "partially_delivered", "failed"),
            ),
            "eta" to Shape(
                listOf("messageId", "vehicleId", "computedAt", "reason"), listOf("stops"),
                "reason" to setOf("departed", "zone_entered", "reordered", "delayed", "completed"),
            ),
            "temperature" to Shape(listOf("messageId", "vehicleId", "sensorId"), listOf("measurements"), null),
        )
    }
}
