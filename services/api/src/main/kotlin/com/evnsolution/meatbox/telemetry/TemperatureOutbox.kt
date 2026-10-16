package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.writeAtomically
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboundDraft
import com.evnsolution.meatbox.integrations.meatbox.outbound.Outbox
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxItem
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxOutcome
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap

private const val BATCH_SIZE = 500
private const val BACKLOG_DAYS = 8L
private const val SENT_KIND = "temperature"
private val MINUTE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMddHHmm")

private fun body(vehicleId: String, sensorId: String, readings: List<Reading>): ObjectNode =
    telemetryJson.createObjectNode().put("vehicleId", vehicleId).put("sensorId", sensorId).also { body ->
        val list: ArrayNode = body.putArray("measurements")
        readings.forEach { list.addObject().put("measuredAt", stamp(it.measuredAt)).put("celsius", it.celsius) }
    }

private fun unique(base: String, taken: Set<String>): String =
    generateSequence(1) { it + 1 }.map { if (it == 1) base else "$base-$it" }.first { it !in taken }

private fun minute(now: Long): String = ZonedDateTime.ofInstant(Instant.ofEpochMilli(now), SEOUL).format(MINUTE)

/** One vehicle's `outbox.json`: how far each day file has been batched, and the messages that batching made. */
private class OutboxFile(val cursor: MutableMap<String, Long>, val entries: List<ObjectNode>)

/**
 * The temperature messages that Meatbox is owed, one `outbox.json` per vehicle next to its day files. The file holds
 * the messages together with a cursor (a byte offset per day file), and every change writes both in one atomic
 * rename: a measurement is either behind the cursor and in a message, or in front of it and waits for the next batch.
 * It is never both and never neither. The cursor follows the order in which measurements arrived, not their time, so
 * a measurement that a terminal resends late goes out with the next batch. Every read-modify-write holds the store's
 * lock, which also covers a second service process.
 */
class TemperatureOutbox(
    private val store: TemperatureStore,
    private val directory: Path,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val active = ConcurrentHashMap.newKeySet<String>()

    init {
        runCatching {
            vehicleDirectories(directory).map { it.fileName.toString() }
                .filter { load(it).entries.any(Outbox::pending) }.forEach(active::add)
        }
    }

    /** Batches what arrived since the last pass, one message per vehicle and sensor. Returns vehicles that failed. */
    fun collect(): List<String> = store.exclusive {
        vehicleDirectories(directory).mapNotNull { vehicle ->
            runCatching { collect(vehicle.fileName.toString(), clock()) }.exceptionOrNull()
                ?.let { vehicle.fileName.toString() }
        }
    }

    private fun collect(vehicleId: String, now: Long) {
        val file = load(vehicleId)
        val oldest = LocalDate.ofInstant(Instant.ofEpochMilli(now), SEOUL).minusDays(BACKLOG_DAYS)
        val cursor = file.cursor.filterKeys { LocalDate.parse(it) >= oldest }.toMutableMap()
        val fresh = dayFiles(directory.resolve(vehicleId)).flatMap { path ->
            val day = path.fileName.toString().removeSuffix(".jsonl")
            if (LocalDate.parse(day) < oldest) return@flatMap emptyList()
            val tail = completeLines(readFrom(path, cursor[day] ?: 0L))
            if (tail.isNotEmpty()) cursor[day] = (cursor[day] ?: 0L) + tail.size
            decode(tail)
        }
        if (fresh.isEmpty() && cursor == file.cursor) return
        val made = fresh.groupBy { it.sensorId }.toSortedMap().flatMap { (sensorId, readings) ->
            readings.sortedBy { it.measuredAt }.chunked(BATCH_SIZE).map { sensorId to it }
        }
        val ids = file.entries.mapTo(HashSet()) { it.path("messageId").asString() }
        val added = made.map { (sensorId, readings) ->
            val messageId = unique("$vehicleId-${minute(now)}-$sensorId", ids).also(ids::add)
            entry(messageId, vehicleId, sensorId, readings, now)
        }
        save(vehicleId, OutboxFile(cursor, Outbox.retained(file.entries + added, now)))
        if (added.isNotEmpty()) active += vehicleId
    }

    private fun entry(messageId: String, vehicleId: String, sensorId: String, readings: List<Reading>, now: Long) =
        Outbox.entry(messageId, OutboundDraft(SENT_KIND, vehicleId, body(vehicleId, sensorId, readings)), now)
            .put("date", dayOf(Instant.ofEpochMilli(now)))

    /** The oldest unsent message of each vehicle that is due. A later message waits for the one before it. */
    fun due(now: Long, limit: Int): List<OutboxItem> = store.exclusive {
        active.toList().mapNotNull { vehicleId ->
            // A vehicle whose file cannot be read is skipped, so one damaged file never stops the others.
            val pending = runCatching { load(vehicleId) }.getOrNull()?.entries.orEmpty().filter(Outbox::pending)
            if (pending.isEmpty()) active -= vehicleId
            pending.firstOrNull()?.takeIf { it.path("nextAttemptAt").asLong() <= now }?.let { message ->
                OutboxItem(
                    message.path("date").asString(), message.path("messageId").asString(), SENT_KIND,
                    message.path("body").deepCopy() as ObjectNode, message.path("attempts").asInt(),
                )
            }
        }.take(limit)
    }

    /** Stores what became of one send and returns the message's attempt count. Unknown messages are ignored. */
    fun record(item: OutboxItem, outcome: OutboxOutcome, status: String, at: Long, next: Long): Int {
        val vehicleId = item.body.path("vehicleId").asString()
        return store.exclusive {
            val file = load(vehicleId)
            val old = file.entries.firstOrNull { it.path("messageId").asString() == item.messageId }
            if (old == null) return@exclusive 0
            val updated = Outbox.withOutcome(old, outcome, status, at, next)
            val entries = Outbox.retained(file.entries.map { if (it === old) updated else it }, at)
            save(vehicleId, OutboxFile(file.cursor, entries))
            if (entries.none(Outbox::pending)) active -= vehicleId
            updated.path("attempts").asInt()
        }
    }

    /** Counts per vehicle of unsent, rejected and sent messages, without bodies. */
    fun summary(): ObjectNode {
        val view = telemetryJson.createObjectNode()
        val rows = view.putArray("vehicles")
        val counts = vehicleDirectories(directory).associate { it.fileName.toString() to load(it.fileName.toString()) }
            .filterValues { it.entries.isNotEmpty() }
        counts.toSortedMap().forEach { (vehicleId, file) ->
            rows.addObject().put("vehicleId", vehicleId).put("pending", file.entries.count(Outbox::pending))
                .put("failed", file.entries.count { !it.path("failedAt").isNull })
                .put("sent", file.entries.count { !it.path("sentAt").isNull })
        }
        return view.put("pending", counts.values.sumOf { it.entries.count(Outbox::pending) })
            .put("failed", counts.values.sumOf { f -> f.entries.count { !it.path("failedAt").isNull } })
            .put("sent", counts.values.sumOf { f -> f.entries.count { !it.path("sentAt").isNull } })
    }

    private fun load(vehicleId: String): OutboxFile {
        val path = directory.resolve(vehicleId).resolve(FILE)
        if (!Files.exists(path, NOFOLLOW_LINKS)) return OutboxFile(mutableMapOf(), emptyList())
        val root = telemetryJson.readTree(Files.readAllBytes(path))
        check(root.path("cursor").isObject && root.path("outbox").isArray)
        val cursor = root.path("cursor").properties().associate { (day, offset) ->
            check(offset.isIntegralNumber)
            day to offset.asLong()
        }.toMutableMap()
        val entries = root.path("outbox").toList().map { node ->
            val entry = node as? ObjectNode ?: error("outbox entry")
            check(listOf("messageId", "kind", "orderId").all { entry.path(it).isString } && entry.path("body").isObject)
            entry
        }
        return OutboxFile(cursor, entries)
    }

    private fun save(vehicleId: String, file: OutboxFile) {
        val root = telemetryJson.createObjectNode()
        val cursor = root.putObject("cursor")
        file.cursor.toSortedMap().forEach { (day, offset) -> cursor.put(day, offset) }
        root.set("outbox", Outbox.toNode(file.entries))
        writeAtomically(directory.resolve(vehicleId).resolve(FILE), telemetryJson.writeValueAsBytes(root))
    }

    private fun readFrom(path: Path, offset: Long): ByteArray = FileChannel.open(path, StandardOpenOption.READ).use {
        val size = it.size()
        if (size <= offset) return ByteArray(0)
        val buffer = ByteBuffer.allocate((size - offset).toInt())
        it.position(offset)
        while (buffer.hasRemaining() && it.read(buffer) >= 0) Unit
        buffer.array()
    }

    private companion object { const val FILE = "outbox.json" }
}
