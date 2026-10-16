package com.evnsolution.meatbox.integrations.meatbox.inbound

import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.legacy.FileStatus
import com.evnsolution.meatbox.legacy.InboundDays
import com.evnsolution.meatbox.legacy.InboundSource
import com.evnsolution.meatbox.legacy.SafeSourceFiles
import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.dispatchMapper
import com.evnsolution.meatbox.dispatch.writeAtomically
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId

/** What one received message did. [state] is `accepted`, `duplicate` or `ignored`. */
class InboundReceipt(
    val orderId: String,
    val version: Long,
    val date: String,
    val state: String,
    val applied: Boolean,
    val draftReset: Boolean,
    /** Why a newer version was kept out of the dispatch (an operator alert code), or null. */
    val held: String?,
    val sourceId: String?,
)

/** The receipt, the file to write (null when nothing changed) and whether the date's draft must be dropped first. */
class InboundOutcome(val receipt: InboundReceipt, val file: ObjectNode?, val resetDraft: Boolean)

/**
 * The orders Meatbox pushed, one file per delivery date. Each order keeps what was `received` last and what is
 * `applied`, i.e. what the dispatch plan sees. The day JSON and the `sourceId` come from `applied` only, so once a
 * date is confirmed nothing the plan depends on can change; later versions wait as warnings for an operator.
 */
@Suppress("TooManyFunctions")
class InboundOrders(
    private val directory: Path,
    private val groupCount: Int = DEFAULT_GROUPS,
    private val clock: () -> Long = System::currentTimeMillis,
) : InboundDays {
    private val files = SafeSourceFiles(directory)
    private var index: MutableMap<String, String>? = null

    override fun dates(): Set<String> = runCatching {
        Files.newDirectoryStream(directory, "*.json").use { stream ->
            stream.map { it.fileName.toString() }.filter(DATE_FILE::matches).map { it.removeSuffix(".json") }.toSet()
        }
    }.getOrDefault(emptySet())

    override fun source(date: String): InboundSource? {
        val file = load(date) ?: return null
        val day = day(file)
        val orders = day["orders"] as ArrayNode
        val boxes = orders.sumOf { it.get("boxes").doubleValue() }
        return InboundSource(sourceId(file), dispatchMapper.writeValueAsBytes(day), orders.size(), boxes)
    }

    /** Counts, warnings and a change stamp for the date snapshot; null when the date has no inbound file. */
    fun summary(date: String): ObjectNode? {
        val file = load(date) ?: return null
        val warnings = file["warnings"] as ArrayNode
        return dispatchMapper.createObjectNode().apply {
            put("kind", "api")
            put("stamp", file["stamp"].asLong())
            put("received", (file["order"] as ArrayNode).size())
            put("applied", activeIds(file).size)
            set("warnings", dispatchMapper.createArrayNode().addAll(warnings.toList().takeLast(SUMMARY_WARNINGS)))
        }
    }

    /**
     * Decides what [order] does to its date, given the date's dispatch [phase] and the orders already [done].
     * Nothing is written here. A message older than the last one received, or the same one again, changes nothing.
     */
    @Synchronized
    @Suppress("CyclomaticComplexMethod", "LongMethod")
    fun plan(order: InboundOrder, phase: String, done: Set<String>): InboundOutcome {
        val now = clock()
        val today = Instant.ofEpochMilli(now).atZone(SEOUL).toLocalDate().toString()
        if (order.deliveryDate < today) reject(UNPROCESSABLE, "DELIVERY_DATE_PAST", "지난 날짜의 주문은 받을 수 없습니다.")
        dateOf(order.orderId)?.takeIf { it != order.deliveryDate }?.let {
            reject(UNPROCESSABLE, "DELIVERY_DATE_CHANGE_UNSUPPORTED", "배송일이 바뀐 주문은 아직 받을 수 없습니다.")
        }
        val file = load(order.deliveryDate)?.deepCopy() ?: emptyFile(order.deliveryDate)
        val orders = file["orders"] as ObjectNode
        val received = orders.get(order.orderId)?.get("received")
        if (received != null) repeated(order, file, received)?.let { return it }
        if (received == null && orderIds(file).size >= MAX_ORDERS) {
            reject(UNPROCESSABLE, "INBOUND_DAY_FULL", "한 날짜에 받을 수 있는 주문 수를 넘었습니다.")
        }

        val before = sourceId(file)
        val record = orders.get(order.orderId) as? ObjectNode ?: dispatchMapper.createObjectNode().also {
            orders.set(order.orderId, it)
            (file["order"] as ArrayNode).add(order.orderId)
        }
        val inPlan = record.get("applied")?.get("status")?.asString() == "active"
        val frozen = phase == "published" || phase == "amending"
        val held = if (frozen) heldCode(order, inPlan, order.orderId in done) else null
        record.set("received", entry(order, withHash = true, at = now))
        if (!frozen) record.set("applied", entry(order, withHash = false, at = now))
        val applied = !frozen
        val reset = phase == "draft" && sourceId(file) != before
        held?.let { warn(file, it, order, now) }
        if (reset) warn(file, "DRAFT_RESET_BY_INBOUND", order, now)
        file.put("stamp", file["stamp"].asLong() + 1)
        val receipt = InboundReceipt(
            order.orderId, order.version, order.deliveryDate, "accepted", applied, reset, held, sourceId(file),
        )
        return InboundOutcome(receipt, file, reset)
    }

    /** Writes a planned file atomically. The caller has already dropped a draft that the file invalidates. */
    @Synchronized
    fun write(file: ObjectNode) {
        val date = file["date"].asString()
        val bytes = dispatchMapper.writeValueAsBytes(file)
        if (bytes.size > MAX_BYTES) reject(UNPROCESSABLE, "INBOUND_DAY_FULL", "한 날짜에 받을 수 있는 크기를 넘었습니다.")
        try {
            Files.createDirectories(directory)
            if (files.status(Path.of("$date.json")) == FileStatus.INVALID) throw IOException("unsafe target")
            writeAtomically(directory.resolve("$date.json"), bytes)
        } catch (_: IOException) {
            reject(HttpStatus.INTERNAL_SERVER_ERROR.value(), "INBOUND_WRITE_FAILED", "주문 저장에 실패했습니다.")
        }
        (file["orders"] as ObjectNode).propertyNames().forEach { index?.put(it, date) }
    }

    /** The outcome of a message that is not newer than the last one received, or null when it is newer. */
    private fun repeated(order: InboundOrder, file: ObjectNode, received: JsonNode): InboundOutcome? {
        val last = received["version"].asLong()
        return when {
            order.version > last -> null
            order.version < last -> unchanged(order, file, "ignored")
            received["hash"].asString() == order.hash -> unchanged(order, file, "duplicate")
            else -> reject(HttpStatus.CONFLICT.value(), "ORDER_VERSION_CONFLICT", "같은 version에 다른 본문이 왔습니다.")
        }
    }

    private fun heldCode(order: InboundOrder, inPlan: Boolean, done: Boolean): String? = when {
        !inPlan -> "ORDER_ADDED_AFTER_DISPATCH".takeIf { order.status == "active" }
        done -> "ORDER_CHANGED_AFTER_COMPLETION"
        order.status == "cancelled" -> "ORDER_CANCELLED_AFTER_DISPATCH"
        else -> "ORDER_CHANGED_AFTER_DISPATCH"
    }

    private fun unchanged(order: InboundOrder, file: ObjectNode, state: String) = InboundOutcome(
        InboundReceipt(order.orderId, order.version, order.deliveryDate, state, false, false, null, sourceId(file)),
        null,
        false,
    )

    private fun entry(order: InboundOrder, withHash: Boolean, at: Long): ObjectNode =
        dispatchMapper.createObjectNode().apply {
            put("version", order.version)
            put("status", order.status)
            if (withHash) put("hash", order.hash)
            put("at", at)
            order.order?.let { set("order", it.deepCopy()) }
            order.phone?.let { put("phone", it) }
        }

    private fun warn(file: ObjectNode, code: String, order: InboundOrder, at: Long) {
        val warnings = file["warnings"] as ArrayNode
        warnings.add(
            dispatchMapper.createObjectNode().put("code", code).put("orderId", order.orderId)
                .put("version", order.version).put("at", at),
        )
        while (warnings.size() > MAX_WARNINGS) warnings.remove(0)
    }

    private fun orderIds(file: ObjectNode): List<String> = (file["order"] as ArrayNode).toList().map { it.asString() }

    private fun activeIds(file: ObjectNode): List<String> = orderIds(file).filter {
        file["orders"][it]["applied"]?.get("status")?.asString() == "active"
    }

    /**
     * `api-` plus the SHA-256 of the sorted `id:version` lines of the applied active orders. The day is built from
     * exactly those, so the same day always has the same id and a cancelled order that never was in it changes nothing.
     */
    private fun sourceId(file: ObjectNode): String {
        val lines = activeIds(file).map { "$it:${file["orders"][it]["applied"]["version"].asLong()}" }
            .sorted().joinToString("\n")
        val digest = MessageDigest.getInstance("SHA-256").digest(lines.toByteArray())
        return "api-" + digest.joinToString("") { "%02x".format(it) }
    }

    private fun day(file: ObjectNode): ObjectNode {
        val ids = activeIds(file)
        val groups = dispatchMapper.createArrayNode()
        val first = groupId(1)
        for (number in 1..groupCount) {
            groups.add(
                dispatchMapper.createObjectNode().put("id", groupId(number)).put("label", "후보 차량 %02d".format(number))
                    .set("regionNames", dispatchMapper.createArrayNode()),
            )
        }
        val position = orderIds(file).withIndex().associate { it.value to it.index }
        val orders = dispatchMapper.createArrayNode()
        ids.forEach { id ->
            orders.add(
                (file["orders"][id]["applied"]["order"] as ObjectNode).deepCopy()
                    .put("groupId", first).put("sequence", position.getValue(id) + 1),
            )
        }
        return dispatchMapper.createObjectNode().apply {
            put("schemaVersion", 1)
            put("date", file["date"].asString())
            set("source", dispatchMapper.createObjectNode().put("kind", "api"))
            set("summary", dispatchMapper.createObjectNode().put("orders", orders.size()).put("boxes", orders.sumOf {
                it.get("boxes").doubleValue()
            }))
            set("groups", groups)
            set("orders", orders)
        }
    }

    private fun groupId(number: Int) = "api-g%02d".format(number)

    private fun emptyFile(date: String): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("schemaVersion", 1)
        put("date", date)
        put("stamp", 0)
        set("order", dispatchMapper.createArrayNode())
        set("orders", dispatchMapper.createObjectNode())
        set("warnings", dispatchMapper.createArrayNode())
    }

    private fun load(date: String): ObjectNode? {
        if (!DATE_NAME.matches(date) || files.status(Path.of("$date.json")) != FileStatus.FILE) return null
        val node = runCatching { dispatchMapper.readTree(files.readRequired(Path.of("$date.json"), false)) }
            .getOrNull() as? ObjectNode ?: invalid()
        val shaped = node["schemaVersion"]?.asInt() == 1 && node["date"]?.asString() == date &&
            node["stamp"]?.isIntegralNumber == true && node["order"] is ArrayNode &&
            node["orders"] is ObjectNode && node["warnings"] is ArrayNode
        return if (shaped) node else invalid()
    }

    /** The delivery date a known order is filed under. The index is read from disk once per start. */
    private fun dateOf(orderId: String): String? {
        val known = index ?: HashMap<String, String>().also { map ->
            dates().forEach { date ->
                (load(date)?.get("orders") as? ObjectNode)?.propertyNames()?.forEach { map[it] = date }
            }
            index = map
        }
        return known[orderId]
    }

    private fun invalid(): Nothing =
        throw DispatchDataException(HttpStatus.INTERNAL_SERVER_ERROR, "DISPATCH_DATA_INVALID")

    private fun reject(status: Int, code: String, message: String): Nothing =
        throw DispatchException(status, code, message)

    companion object {
        const val DEFAULT_GROUPS = 8
        const val UNPROCESSABLE = 422
        private const val MAX_ORDERS = 5000
        private const val MAX_BYTES = 16 * 1024 * 1024
        private const val MAX_WARNINGS = 200
        private const val SUMMARY_WARNINGS = 50
        private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
        private val DATE_NAME = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val DATE_FILE = Regex("^\\d{4}-\\d{2}-\\d{2}\\.json$")
    }
}
