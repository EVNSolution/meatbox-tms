package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode

internal val dispatchMapper: JsonMapper = JsonMapper.builder().build()

internal fun copyNode(node: JsonNode): JsonNode =
    dispatchMapper.readTree(dispatchMapper.writeValueAsBytes(node))

internal fun copyObject(node: ObjectNode): ObjectNode = copyNode(node) as ObjectNode

internal fun ObjectNode.setCopy(name: String, value: JsonNode?) {
    set(name, value?.let(::copyNode) ?: dispatchMapper.nullNode())
}

open class DispatchException(
    val status: Int,
    val code: String,
    override val message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

/**
 * The prepared source of a date no longer matches the one its checkpoint was saved against. Nothing is decided here:
 * an operator picks `keep-checkpoint` or `discard-checkpoint` (see `DispatchStore.resolveSourceConflict`).
 */
class SourceConflict(
    val expectedSourceId: String,
    val actualSourceId: String,
    val checkpointPhase: String,
    val detectedAt: Long,
    val reason: String,
) {
    fun toNode(): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("expectedSourceId", expectedSourceId)
        put("actualSourceId", actualSourceId)
        put("detectedAt", java.time.Instant.ofEpochMilli(detectedAt).toString())
        put("checkpointPhase", checkpointPhase)
        put("reason", reason)
    }
}

class SourceChangedException(val conflict: SourceConflict) :
    DispatchException(CONFLICT, "SOURCE_CHANGED", "원본 내용이 바뀌어 확인이 필요합니다.")

private const val CONFLICT = 409
