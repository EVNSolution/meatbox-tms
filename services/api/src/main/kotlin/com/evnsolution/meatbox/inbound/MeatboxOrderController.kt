package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.dispatch.dispatchMapper
import com.evnsolution.meatbox.ops.ErrorAlerts
import jakarta.servlet.http.HttpServletRequest
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.io.ByteArrayOutputStream

/** Contract 4: Meatbox pushes orders here. Authentication is [MeatboxInboundFilter]'s job. */
@RestController
@RequestMapping("/api/meatbox")
@ConditionalOnExpression("'\${meatbox.dispatch.enabled:false}' == 'true' && '\${meatbox.inbound.token:}' != ''")
class MeatboxOrderController(
    private val store: DispatchStore,
    private val alerts: ErrorAlerts,
) {
    private val parser = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()

    @PostMapping("/orders")
    fun receive(
        @RequestHeader("Idempotency-Key", required = false) key: String?,
        request: HttpServletRequest,
    ): ResponseEntity<ObjectNode> {
        val order = InboundOrder.parse(body(request))
        if (key != "${order.orderId}:${order.version}") {
            fail(BAD_REQUEST, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key는 orderId:version이어야 합니다.")
        }
        val receipt = store.receiveOrder(order)
        receipt.held?.let {
            val detail = "date=${receipt.date} orderId=${receipt.orderId} version=${receipt.version}"
            alerts.report("meatbox-inbound", it, detail)
        }
        val json = dispatchMapper.createObjectNode().apply {
            put("accepted", true)
            put("duplicate", receipt.state == "duplicate")
            put("ignored", receipt.state == "ignored")
            put("applied", receipt.applied)
            put("draftReset", receipt.draftReset)
            if (receipt.held == null) putNull("held") else put("held", receipt.held)
            put("orderId", receipt.orderId)
            put("version", receipt.version)
            put("date", receipt.date)
            if (receipt.sourceId == null) putNull("sourceId") else put("sourceId", receipt.sourceId)
        }
        return ResponseEntity.status(if (receipt.state == "accepted") ACCEPTED else OK).body(json)
    }

    private fun body(request: HttpServletRequest): ObjectNode {
        val isJson = request.contentType?.substringBefore(';')?.trim()?.equals("application/json", true) == true
        if (!isJson) fail(UNSUPPORTED_MEDIA_TYPE, "INVALID_ORDER", "Content-Type은 application/json이어야 합니다.")
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = request.inputStream.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_BODY) fail(PAYLOAD_TOO_LARGE, "ORDER_TOO_LARGE", "주문 본문이 너무 큽니다.")
            output.write(buffer, 0, count)
        }
        return runCatching { parser.readTree(output.toByteArray()) as? ObjectNode }.getOrNull()
            ?: fail(BAD_REQUEST, "INVALID_ORDER", "주문 본문이 JSON 객체가 아닙니다.")
    }

    private fun fail(status: Int, code: String, message: String): Nothing =
        throw DispatchException(status, code, message)

    private companion object {
        const val OK = 200
        const val ACCEPTED = 202
        const val BAD_REQUEST = 400
        const val PAYLOAD_TOO_LARGE = 413
        const val UNSUPPORTED_MEDIA_TYPE = 415
        const val MAX_BODY = 1024 * 1024
    }
}
