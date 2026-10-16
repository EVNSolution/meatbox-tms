package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.dispatch.CommandResults
import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.dispatchMapper
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle

/**
 * One order message of contract 4, checked and mapped. [order] is the dispatch day's order object (without group and
 * sequence, which the day builder adds) and is null for a cancellation, which only needs the first four fields.
 * [phone] is kept for later screens and never put into the day JSON.
 */
class InboundOrder(
    val orderId: String,
    val version: Long,
    val status: String,
    val deliveryDate: String,
    val hash: String,
    val order: ObjectNode?,
    val phone: String?,
) {
    companion object {
        private const val BAD_REQUEST = 400
        private const val MAX_ITEMS = 200
        private const val MAX_TEXT = 300
        private const val MAX_SHORT = 64
        private val ID = Regex("^[A-Za-z0-9._-]{1,64}$")
        private val DATE = DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)
        private val TYPES = setOf("fresh", "parcel")

        fun parse(body: ObjectNode): InboundOrder {
            val orderId = text(body, "orderId", MAX_SHORT)
            if (!ID.matches(orderId)) bad("orderId")
            val version = body.get("version")?.takeIf { it.isIntegralNumber && it.canConvertToLong() }?.asLong()
                ?.takeIf { it >= 1 } ?: bad("version")
            val status = text(body, "status", MAX_SHORT)
            if (status != "active" && status != "cancelled") bad("status")
            val date = text(body, "deliveryDate", MAX_SHORT)
            if (runCatching { LocalDate.parse(date, DATE) }.isFailure) bad("deliveryDate")
            val hash = CommandResults.digest(body)
            if (status == "cancelled") return InboundOrder(orderId, version, status, date, hash, null, null)
            return activeOrder(body, orderId, version, status, date, hash)
        }

        private fun activeOrder(
            body: ObjectNode,
            orderId: String,
            version: Long,
            status: String,
            date: String,
            hash: String,
        ): InboundOrder {
            val type = text(body, "deliveryType", MAX_SHORT)
            if (type !in TYPES) bad("deliveryType")
            val customer = body.get("customer") as? ObjectNode ?: bad("customer")
            val address = body.get("address") as? ObjectNode ?: bad("address")
            val items = items(body.get("items"))
            val order = dispatchMapper.createObjectNode().apply {
                put("id", orderId)
                put("orderNumber", orderId)
                put("name", text(customer, "name", MAX_TEXT))
                put("address", text(address, "road", MAX_TEXT))
                put("detailAddress", optional(address, "detail", MAX_TEXT) ?: "")
                putNumber("boxes", items.sumOf { it.get("boxes").doubleValue() })
                put("sourceRows", 1)
                put("deliveryType", type)
                put("sourceVersion", version)
                set("items", dispatchMapper.createArrayNode().addAll(items))
                optional(body, "csNote", MAX_TEXT)?.let { put("csNote", it) }
                // The web fork requires `coordinates` to be present: null when unknown, like prepared days.
                set("coordinates", coordinates(address) ?: dispatchMapper.nullNode())
                set("zoneIds", dispatchMapper.createArrayNode())
                access(body.get("access"))?.let { set("access", it) }
            }
            return InboundOrder(orderId, version, status, date, hash, order, optional(customer, "phone", MAX_SHORT))
        }

        private fun items(node: JsonNode?): List<ObjectNode> {
            val array = node as? ArrayNode ?: bad("items")
            if (array.isEmpty || array.size() > MAX_ITEMS) bad("items")
            return array.toList().map { value ->
                val item = value as? ObjectNode ?: bad("items")
                dispatchMapper.createObjectNode().apply {
                    put("sku", text(item, "sku", MAX_SHORT))
                    optional(item, "name", MAX_TEXT)?.let { put("name", it) }
                    putNumber("qty", number(item, "qty", required = true)!!)
                    putNumber("boxes", number(item, "boxes", required = true)!!)
                    number(item, "weightKg", required = false)?.let { putNumber("weightKg", it) }
                    optional(item, "barcode", MAX_SHORT)?.let { put("barcode", it) }
                }
            }
        }

        private fun coordinates(address: ObjectNode): ArrayNode? {
            val lat = address.get("lat")?.takeIf { !it.isNull }
            val lng = address.get("lng")?.takeIf { !it.isNull }
            if (lat == null && lng == null) return null
            val valid = lat != null && lng != null && lat.isNumber && lng.isNumber &&
                lat.doubleValue() in -90.0..90.0 && lng.doubleValue() in -180.0..180.0
            if (!valid) bad("address.lat/lng")
            return dispatchMapper.createArrayNode().add(lng!!.doubleValue()).add(lat!!.doubleValue())
        }

        private fun access(node: JsonNode?): ObjectNode? {
            if (node == null || node.isNull) return null
            val source = node as? ObjectNode ?: bad("access")
            val out = dispatchMapper.createObjectNode()
            for (key in listOf("entranceCode", "placeNote")) optional(source, key, MAX_TEXT)?.let { out.put(key, it) }
            return out.takeIf { !it.isEmpty }
        }

        // Whole numbers stay integers, as in the prepared CSV days.
        private fun ObjectNode.putNumber(key: String, value: Double) {
            if (value % 1.0 == 0.0 && value < Long.MAX_VALUE) put(key, value.toLong()) else put(key, value)
        }

        private fun number(parent: ObjectNode, key: String, required: Boolean): Double? {
            val node = parent.get(key)?.takeIf { !it.isNull } ?: return if (required) bad(key) else null
            if (!node.isNumber || !node.doubleValue().isFinite() || node.doubleValue() < 0.0) bad(key)
            return node.doubleValue()
        }

        private fun text(parent: ObjectNode, key: String, max: Int): String =
            optional(parent, key, max)?.takeIf { it.isNotBlank() } ?: bad(key)

        private fun optional(parent: ObjectNode, key: String, max: Int): String? {
            val node = parent.get(key)?.takeIf { !it.isNull } ?: return null
            if (!node.isString || node.asString().length > max) bad(key)
            return node.asString().trim()
        }

        private fun bad(field: String): Nothing =
            throw DispatchException(BAD_REQUEST, "INVALID_ORDER", "주문 본문의 $field 값을 확인해 주세요.")
    }
}
