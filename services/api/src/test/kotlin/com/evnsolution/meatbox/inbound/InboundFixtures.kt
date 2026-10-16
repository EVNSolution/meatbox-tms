package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.dispatch.dispatchMapper
import tools.jackson.databind.node.ObjectNode

internal const val INBOUND_DATE = "2026-10-14"

/** A contract-4 body. Every call with the same arguments gives the same JSON. */
internal fun orderBody(
    id: String,
    version: Int = 1,
    status: String = "active",
    date: String = INBOUND_DATE,
    name: String = "가게 $id",
    road: String = "서울 강남구 $id",
    boxes: Int = 2,
    extra: String = "",
): ObjectNode {
    val cancelled = status == "cancelled"
    val full = if (cancelled) "" else """,
        "deliveryType":"fresh",
        "customer":{"name":"$name","phone":"010-0000-0000"},
        "address":{"road":"$road","detail":"지하 1층","lat":37.5,"lng":127.0},
        "access":{"entranceCode":"1234*","placeNote":"뒷문"},
        "items":[{"sku":"PK-001","name":"삼겹살","qty":3,"boxes":$boxes,"weightKg":3.2,"barcode":"8801234567890"}],
        "csNote":"오전 배송"$extra"""
    return dispatchMapper.readTree(
        """{"orderId":"$id","version":$version,"status":"$status","deliveryDate":"$date"$full}""",
    ) as ObjectNode
}

internal fun order(
    id: String,
    version: Int = 1,
    status: String = "active",
    date: String = INBOUND_DATE,
    boxes: Int = 2,
) =
    InboundOrder.parse(orderBody(id, version, status, date, boxes = boxes))
