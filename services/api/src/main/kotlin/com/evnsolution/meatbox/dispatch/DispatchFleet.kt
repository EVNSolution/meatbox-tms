package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.math.BigDecimal
import java.math.RoundingMode

private data class Capital(val label: String, val longitude: Double, val latitude: Double)

private val capitals = listOf(
    Capital("서울 강서", 126.8495, 37.5509),
    Capital("서울 송파", 127.1059, 37.5145),
    Capital("서울 금천", 126.8955, 37.4569),
    Capital("인천 남동", 126.7315, 37.4473),
    Capital("인천 계양", 126.7377, 37.5372),
    Capital("경기 고양", 126.8320, 37.6584),
    Capital("경기 성남", 127.1378, 37.4200),
    Capital("경기 수원", 127.0286, 37.2636),
    Capital("경기 용인", 127.1776, 37.2411),
    Capital("경기 부천", 126.7660, 37.5034),
    Capital("경기 안양", 126.9568, 37.3943),
    Capital("경기 남양주", 127.2165, 37.6360),
)
private val plateLetters = listOf(
    "가", "나", "다", "라", "마", "거", "너", "더", "러", "머", "버", "서", "어", "저",
)

private const val BAD_REQUEST = 400
private const val COORDINATE_SCALE = 6
private const val FNV_OFFSET_BASIS = 2166136261u
private const val FNV_PRIME = 16777619u

fun createDispatchFleet(day: ObjectNode): List<ObjectNode> {
    validateDay(day)
    return (day["groups"] as ArrayNode).toList().map { group -> demoVehicle(group as ObjectNode) }
}

internal fun validateDay(day: ObjectNode) {
    if (!hasSupportedSchema(day) || day["date"]?.isString != true) {
        invalidDay("배차 원본 자료 형식이 올바르지 않습니다.")
    }
    val groups = day["groups"] as? ArrayNode ?: invalidDay("배차 원본 자료 형식이 올바르지 않습니다.")
    val orders = day["orders"] as? ArrayNode ?: invalidDay("배차 원본 자료 형식이 올바르지 않습니다.")

    val groupIds = validateGroups(groups)
    validateOrders(orders, groupIds)
}

private fun hasSupportedSchema(day: ObjectNode): Boolean {
    val schemaVersion = day["schemaVersion"]
    val exactVersion = runCatching {
        schemaVersion?.decimalValue()?.stripTrailingZeros()?.longValueExact()
    }.getOrNull()
    return schemaVersion?.isNumber == true && schemaVersion.doubleValue().isFinite() && exactVersion == 1L
}

private fun validateGroups(groups: ArrayNode): Set<String> {
    val groupIds = mutableSetOf<String>()
    groups.forEach { value ->
        val group = value as? ObjectNode ?: invalidDay("배차 기사 자료를 확인해 주세요.")
        val id = group["id"]?.takeIf(JsonNode::isString)?.asString()
        val validIdentity = !id.isNullOrEmpty() && groupIds.add(id)
        val validDescription = group["label"]?.isString == true && group["regionNames"]?.isArray == true
        if (!validIdentity || !validDescription) {
            invalidDay("배차 기사 자료를 확인해 주세요.")
        }
    }
    return groupIds
}

private fun validateOrders(orders: ArrayNode, groupIds: Set<String>) {
    val orderIds = mutableSetOf<String>()
    orders.forEach { value ->
        val order = value as? ObjectNode ?: invalidDay("배차 주문 자료를 확인해 주세요.")
        val id = order["id"]?.takeIf(JsonNode::isString)?.asString()
        val groupId = order["groupId"]?.takeIf(JsonNode::isString)?.asString()
        val boxes = order["boxes"]
        val validIdentity = !id.isNullOrEmpty() && orderIds.add(id) && groupId in groupIds
        val validBoxes = boxes?.isNumber == true && boxes.doubleValue().isFinite() && boxes.doubleValue() >= 0.0
        if (!validIdentity || !validBoxes) {
            invalidDay("배차 주문 자료를 확인해 주세요.")
        }
    }
}

private fun demoVehicle(group: ObjectNode): ObjectNode {
    val id = group["id"].asString()
    val seed = hash(id)
    val capital = capitals[(seed % capitals.size.toUInt()).toInt()]
    val offsetX = (((seed shr 8).toInt() % 101) - 50) / 10000.0
    val offsetY = (((seed shr 16).toInt() % 101) - 50) / 10000.0
    val plateNumber = 11 + (seed % 89u).toInt()
    val plateLetter = plateLetters[((seed shr 7) % plateLetters.size.toUInt()).toInt()]
    val plateSuffix = (1000 + ((seed shr 12) % 9000u).toInt()).toString().padStart(4, '0')
    return dispatchMapper.createObjectNode().apply {
        put("id", id)
        put("driver", group["label"].asString())
        put("plate", "$plateNumber$plateLetter $plateSuffix")
        put("region", group["regionNames"].joinToString(", ") { it.asString() })
        put("live", false)
        put("source", "demo-vehicle")
        set("location", dispatchMapper.createObjectNode().apply {
            putArray("coordinates").add(roundSix(capital.longitude + offsetX)).add(roundSix(capital.latitude + offsetY))
            put("label", "${capital.label} 예시 위치")
            put("source", "demo")
        })
    }
}

private fun hash(value: String): UInt {
    var result = FNV_OFFSET_BASIS
    value.codePoints().forEach { character ->
        result = (result xor character.toUInt()) * FNV_PRIME
    }
    return result
}

private fun roundSix(value: Double): Double =
    BigDecimal.valueOf(value).setScale(COORDINATE_SCALE, RoundingMode.HALF_UP).toDouble()

private fun invalidDay(message: String): Nothing =
    throw DispatchException(BAD_REQUEST, "INVALID_DAY", message)
