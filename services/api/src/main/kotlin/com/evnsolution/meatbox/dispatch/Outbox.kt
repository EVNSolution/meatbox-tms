package com.evnsolution.meatbox.dispatch

import jakarta.servlet.http.HttpServletResponse
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/** A message that a state change wants sent to Meatbox. The store gives it its `messageId` when it commits. */
class OutboundDraft(val kind: String, val orderId: String, val body: ObjectNode)

/** One message that is due now, as the sender sees it. */
class OutboxItem(val date: String, val messageId: String, val kind: String, val body: ObjectNode, val attempts: Int)

enum class OutboxOutcome { SENT, RETRY, REJECTED }

private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")

internal fun seoulStamp(millis: Long): String =
    Instant.ofEpochMilli(millis).atZone(SEOUL).truncatedTo(ChronoUnit.SECONDS)
        .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

/** The body of contract 3.1. `messageId` is added by the store. */
fun deliveryStatusBody(
    orderId: String,
    status: String,
    occurredAt: String,
    vehicleId: String,
    photos: List<String> = emptyList(),
    note: String? = null,
    items: JsonNode? = null,
    failure: JsonNode? = null,
): ObjectNode = dispatchMapper.createObjectNode().apply {
    put("orderId", orderId)
    put("status", status)
    put("occurredAt", occurredAt)
    put("vehicleId", vehicleId)
    set("photos", dispatchMapper.createArrayNode().apply { photos.forEach(::add) })
    note?.let { put("note", it) } ?: putNull("note")
    items?.let { set("items", it) } ?: putNull("items")
    failure?.let { set("failure", it) } ?: putNull("failure")
}

/**
 * The outbox of one date: messages that a committed state change owes Meatbox. The list lives in the date's
 * checkpoint, so a message and the change that caused it are written by the same file write.
 */
internal object Outbox {
    // Sent and rejected entries stay for a day so the ops view can show them; unsent ones are never dropped.
    private const val FINISHED_LIMIT = 1000
    private const val FINISHED_RETENTION_MILLIS = 24 * 60 * 60 * 1000L
    private val ID = Regex("[^A-Za-z0-9._-]")

    fun messageId(date: String, revision: Long, orderId: String): String = "$date-$revision-${ID.replace(orderId, "_")}"

    fun entry(messageId: String, draft: OutboundDraft, now: Long): ObjectNode =
        dispatchMapper.createObjectNode().apply {
            put("messageId", messageId)
            put("kind", draft.kind)
            put("orderId", draft.orderId)
            set("body", copyObject(draft.body).put("messageId", messageId))
            put("attempts", 0)
            put("createdAt", now)
            put("nextAttemptAt", now)
            putNull("sentAt")
            putNull("failedAt")
            putNull("lastStatus")
        }

    fun pending(entry: JsonNode): Boolean = entry.path("sentAt").isNull && entry.path("failedAt").isNull

    fun toNode(list: List<ObjectNode>): JsonNode = dispatchMapper.createArrayNode().apply { list.forEach(::add) }

    /** A checkpoint without the field has an empty outbox, so files written before it existed still load. */
    fun fromCheckpoint(saved: ObjectNode?): List<ObjectNode> {
        val node = saved?.get("outbox") ?: return emptyList()
        if (!node.isArray) invalid()
        return node.toList().map { item ->
            val entry = item as? ObjectNode ?: invalid()
            val shaped = listOf("messageId", "kind", "orderId").all { entry.path(it).isString } &&
                entry.path("body") is ObjectNode && entry.path("attempts").isIntegralNumber &&
                entry.path("nextAttemptAt").isIntegralNumber && entry.has("sentAt") && entry.has("failedAt")
            if (!shaped) invalid()
            entry
        }
    }

    fun retained(list: List<ObjectNode>, now: Long): List<ObjectNode> {
        val finished = list.filter { !pending(it) && now - finishedAt(it) < FINISHED_RETENTION_MILLIS }
            .takeLast(FINISHED_LIMIT).toSet()
        return list.filter { pending(it) || it in finished }
    }

    fun withOutcome(entry: ObjectNode, outcome: OutboxOutcome, status: String, at: Long, next: Long): ObjectNode =
        copyObject(entry).apply {
            put("attempts", path("attempts").asInt() + 1)
            put("lastStatus", status)
            when (outcome) {
                OutboxOutcome.SENT -> put("sentAt", at)
                OutboxOutcome.REJECTED -> put("failedAt", at)
                OutboxOutcome.RETRY -> put("nextAttemptAt", next)
            }
        }

    /** Counts and the newest [recent] entries, without bodies: the ops view must not carry order contents. */
    fun summary(date: String, list: List<ObjectNode>, recent: Int): ObjectNode =
        dispatchMapper.createObjectNode().apply {
            put("date", date)
            put("pending", list.count(::pending))
            put("failed", list.count { !it.path("failedAt").isNull })
            put("sent", list.count { !it.path("sentAt").isNull })
            set("recent", dispatchMapper.createArrayNode().apply {
                list.takeLast(recent).reversed().forEach { add(view(it)) }
            })
        }

    private fun view(entry: ObjectNode): ObjectNode = dispatchMapper.createObjectNode().apply {
        listOf("messageId", "kind", "orderId", "lastStatus").forEach {
            put(it, entry.path(it).asString("").ifEmpty { null })
        }
        put("attempts", entry.path("attempts").asInt())
        listOf("nextAttemptAt", "sentAt", "failedAt").forEach { key ->
            val at = entry.path(key)
            val shown = at.takeIf { it.isIntegralNumber && (key != "nextAttemptAt" || pending(entry)) }
            put(key, shown?.let { seoulStamp(it.asLong()) })
        }
    }

    private fun finishedAt(entry: JsonNode): Long =
        listOf("sentAt", "failedAt").maxOf { entry.path(it).asLong(0) }

    private fun invalid(): Nothing = throw DispatchException(
        HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
        "DISPATCH_STATE_INVALID",
        "DISPATCH_STATE_INVALID",
    )
}
