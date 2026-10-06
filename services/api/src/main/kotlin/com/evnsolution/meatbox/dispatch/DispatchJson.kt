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

class DispatchException(
    val status: Int,
    val code: String,
    override val message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
