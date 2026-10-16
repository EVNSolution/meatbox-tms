package com.evnsolution.meatbox.dispatch

import jakarta.servlet.http.HttpServletResponse
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.security.MessageDigest
import java.util.TreeMap

internal data class StoredResult(val requestId: String, val hash: String, val savedAt: Long, val response: ObjectNode)

/** Stored command results of one date: lookup, body hash, retention and the checkpoint `commandResults` field. */
internal object CommandResults {
    // The first limit reached drops the oldest result. Responses carry a full snapshot, so the byte cap keeps
    // the checkpoint under the store's file limit.
    private const val MAX_RESULTS = 500
    private const val RETENTION_MILLIS = 24 * 60 * 60 * 1000L
    private const val MAX_BYTES = 8 * 1024 * 1024
    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun validId(value: String): Boolean = ID.matches(value)

    fun find(results: List<StoredResult>, requestId: String, now: Long): StoredResult? =
        results.firstOrNull { it.requestId == requestId && now - it.savedAt < RETENTION_MILLIS }

    /** Drops expired results, then the oldest ones until the count and byte limits hold. The newest always stays. */
    fun retained(results: List<StoredResult>, now: Long): List<StoredResult> {
        var kept = results.filter { now - it.savedAt < RETENTION_MILLIS }.takeLast(MAX_RESULTS)
        var bytes = kept.sumOf { size(it) }
        while (kept.size > 1 && bytes > MAX_BYTES) {
            bytes -= size(kept.first())
            kept = kept.drop(1)
        }
        return kept
    }

    /** SHA-256 of the command without requestId, with object keys sorted so key order cannot matter. */
    fun digest(command: ObjectNode): String {
        val bytes = dispatchMapper.writeValueAsBytes(canonical(command.deepCopy().apply { remove("requestId") }))
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    fun toNode(results: List<StoredResult>): JsonNode = dispatchMapper.createArrayNode().apply {
        results.forEach {
            add(
                dispatchMapper.createObjectNode().apply {
                    put("requestId", it.requestId)
                    put("hash", it.hash)
                    put("savedAt", it.savedAt)
                    set("response", it.response)
                },
            )
        }
    }

    /** A checkpoint without the field has no results, so schema-2 files written before this field still load. */
    fun fromCheckpoint(saved: ObjectNode?): List<StoredResult> {
        val node = saved?.get("commandResults") ?: return emptyList()
        if (!node.isArray) invalid()
        return node.toList().map(::fromNode)
    }

    private fun fromNode(item: JsonNode): StoredResult {
        val response = item.get("response") as? ObjectNode ?: invalid()
        val id = item.get("requestId")?.takeIf(JsonNode::isString)?.asString()?.takeIf(::validId) ?: invalid()
        val hash = item.get("hash")?.takeIf(JsonNode::isString)?.asString() ?: invalid()
        val savedAt = item.get("savedAt")?.takeIf { it.isIntegralNumber }?.asLong() ?: invalid()
        return StoredResult(id, hash, savedAt, response)
    }

    private fun size(result: StoredResult): Long = dispatchMapper.writeValueAsBytes(result.response).size.toLong()

    private fun canonical(node: JsonNode): JsonNode = when {
        node.isObject -> dispatchMapper.createObjectNode().also { out ->
            TreeMap<String, JsonNode>().apply { node.properties().forEach { (k, v) -> put(k, v) } }
                .forEach { (k, v) -> out.set(k, canonical(v)) }
        }
        node.isArray -> dispatchMapper.createArrayNode().also { out -> node.forEach { out.add(canonical(it)) } }
        else -> node
    }

    private fun invalid(): Nothing = throw DispatchException(
        HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
        "DISPATCH_STATE_INVALID",
        "DISPATCH_STATE_INVALID",
    )
}
