package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboundDraft
import com.evnsolution.meatbox.integrations.meatbox.outbound.Outbox
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxItem
import com.evnsolution.meatbox.integrations.meatbox.outbound.OutboxOutcome
import com.evnsolution.meatbox.integrations.meatbox.outbound.superseded
import com.evnsolution.meatbox.integrations.meatbox.outbound.deliveryStatusBody
import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.SafeSourceFiles
import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.integrations.meatbox.inbound.InboundOrder
import com.evnsolution.meatbox.integrations.meatbox.inbound.InboundOrders
import com.evnsolution.meatbox.integrations.meatbox.inbound.InboundReceipt
import jakarta.servlet.http.HttpServletResponse
import java.io.IOException
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.Path
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID
import org.slf4j.LoggerFactory

private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")

// One lock and one file per date keep every command atomic; splitting the store would expose its internals.
@Suppress("TooManyFunctions")
class DispatchStore(
    private val reader: DispatchDataReader,
    private val stateDirectory: Path,
    private val clock: () -> Long = System::currentTimeMillis,
    private val inbound: InboundOrders? = null,
) {
    val boot: String = UUID.randomUUID().toString()

    /** Set by the driver module. It must answer without taking any lock that waits for this store. */
    @Volatile var locations: DriverLocationSource? = null

    /** Set by the driver module. Told which vehicles an operator command changed; it must only queue work. */
    @Volatile var routeChanges: RouteChangeListener? = null

    /** Set by the telemetry module. Same rule: it must not wait for this store. */
    @Volatile var temperatures: TemperatureSource? = null

    /** Set by the ops module. Told once per new source conflict; it must only queue work. */
    @Volatile var onSourceConflict: ((String, SourceConflict) -> Unit)? = null
    private val conflictSince = mutableMapOf<String, Pair<String, Long>>()
    private val parser = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()
    private val stateFiles = SafeSourceFiles(stateDirectory)
    private val outboxDates = sortedSetOf<String>()
    private var outboxScanned = false
    // ponytail: one service-wide lock; use per-date locks if measured throughput requires them.
    private val entries = object : LinkedHashMap<String, Entry>(4, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>): Boolean = size > MAX_DATES
    }

    /** The shared region polygons (GeoJSON), or null when the installation has none or they cannot be read. */
    @Synchronized
    fun regions(): JsonNode? = runCatching { parser.readTree(reader.regions(null).bytes) }.getOrNull()

    @Synchronized
    fun snapshot(date: String): ObjectNode = entry(date).let { publicState(it.plan.snapshot(), it) }

    /** Like [snapshot], but a source conflict is answered as a state of its own so that the operator can see it. */
    @Synchronized
    fun stateOrConflict(date: String): ObjectNode = try {
        snapshot(date)
    } catch (error: SourceChangedException) {
        dispatchMapper.createObjectNode().apply {
            put("date", date)
            put("boot", boot)
            putNull("dispatch")
            set("sourceConflict", error.conflict.toNode())
        }
    }

    @Synchronized
    fun command(date: String, command: ObjectNode): ObjectNode {
        if (!command.path("expectedBoot").isString) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        val requestId = requestId(command)
        // A stored result is answered before the CAS, so a resend after a lost response or restart is not a conflict.
        val hash = requestId?.let { CommandResults.digest(command) }
        if (requestId != null) replay(date, requestId, hash!!)?.let { return it }
        if (command.path("expectedBoot").asString() != boot) {
            fail(HttpServletResponse.SC_CONFLICT, "BOOT_MISMATCH", "서버가 다시 시작되었습니다. 최신 상태를 다시 불러와 주세요.")
        }
        val current = entry(date)
        val candidate = DispatchPlan(current.day, current.sourceId, clock, current.plan.exportCheckpoint())
        val output = candidate.command(command)
        output.set("state", publicState(output.path("state") as ObjectNode, current))
        val type = command.path("type").asString()
        val published = type == "publish_dispatch"
        val drafts = if (published) dispatched(current.plan, candidate) else emptyList()
        val listener = routeChanges?.takeIf { type in ROUTE_CHANGING_COMMANDS }
        val changes = listener?.let { routeChanges(current.plan.snapshot(), candidate.snapshot()) }.orEmpty()
        commit(date, current, candidate, requestId, hash, output, drafts)
        if (changes.isNotEmpty()) {
            // A failing notification must never undo or fail the operator's command.
            runCatching { listener?.changed(date, candidate.revision, changes) }
        }
        return output
    }

    /**
     * Applies the steps [prepare] derives from the current snapshot as one unit: one stored result under [requestId],
     * one checkpoint write, and nothing at all when any step fails. Callers translate their own events into the
     * existing operational commands; this adds no command of its own. Like [command], a stored result wins over every
     * check, but there is no boot check because the driver app never sees the boot.
     */
    @Synchronized
    fun batch(date: String, requestId: String, body: ObjectNode, prepare: (ObjectNode) -> CommandBatch): BatchResult {
        if (!CommandResults.validId(requestId)) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        val hash = CommandResults.digest(body)
        replay(date, requestId, hash)?.let { return BatchResult(it, true) }
        val current = entry(date)
        val candidate = DispatchPlan(current.day, current.sourceId, clock, current.plan.exportCheckpoint())
        val planned = prepare(Etas.overlay(candidate.snapshot(), current.etas))
        planned.steps.forEach { candidate.command(copyObject(it).put("expectedRevision", candidate.revision)) }
        val after = candidate.snapshot()
        val etas = planned.etas(after)
        val shown = Etas.overlay(after, current.etas + etas)
        val response = planned.respond(shown)
        commit(date, current, candidate, requestId, hash, response, planned.outbound(shown), etas)
        return BatchResult(copyObject(response), false)
    }

    private fun replay(date: String, requestId: String, hash: String): ObjectNode? =
        CommandResults.find(entry(date).results, requestId, clock())?.let {
            if (it.hash != hash) fail(
                HttpServletResponse.SC_CONFLICT,
                "REQUEST_ID_MISMATCH",
                "같은 요청 ID에 다른 명령이 들어왔습니다.",
            )
            copyObject(it.response)
        }

    private fun commit(
        date: String,
        current: Entry,
        candidate: DispatchPlan,
        requestId: String?,
        hash: String?,
        output: ObjectNode,
        drafts: List<OutboundDraft> = emptyList(),
        newEtas: Map<String, ObjectNode> = emptyMap(),
    ) {
        val results = if (requestId == null) current.results else CommandResults.retained(
            current.results + StoredResult(requestId, hash!!, clock(), copyObject(output)), clock(),
        )
        val outbox = if (drafts.isEmpty()) current.outbox else Outbox.retained(
            superseded(current.outbox, drafts) + drafts.map {
                Outbox.entry(Outbox.messageId(date, candidate.revision, it.orderId, it.idSuffix), it, clock())
            },
            clock(),
        )
        val etas = current.etas + newEtas
        // One file write carries the new state, its result, ETAs and owed messages: none exists without the rest.
        write(date, candidate, results, outbox, etas, current.contentHash)
        entries[date] = current.copy(plan = candidate, results = results, outbox = outbox, etas = etas)
        if (drafts.isNotEmpty()) outboxDates += date
    }

    private fun write(
        date: String,
        plan: DispatchPlan,
        results: List<StoredResult>,
        outbox: List<ObjectNode>,
        etas: Map<String, ObjectNode>,
        contentHash: String,
    ) {
        save(date, plan.exportCheckpoint().also { checkpoint ->
            checkpoint.put("contentHash", contentHash)
            if (results.isNotEmpty()) checkpoint.set("commandResults", CommandResults.toNode(results))
            if (outbox.isNotEmpty()) checkpoint.set("outbox", Outbox.toNode(outbox))
            if (etas.isNotEmpty()) checkpoint.set("etas", Etas.toNode(etas))
        })
    }

    /** Orders whose vehicle this publish set or changed. A first publish names every order. */
    private fun dispatched(before: DispatchPlan, after: DispatchPlan): List<OutboundDraft> {
        fun vehicles(plan: DispatchPlan) = plan.snapshot().path("fleetDeliveries").toList()
            .associate { it.path("id").asString() to it.path("vehicleId").asString() }
        val old = vehicles(before)
        val stamp = seoulStamp(clock())
        return vehicles(after).filter { (id, vehicle) -> old[id] != vehicle }.map { (id, vehicle) ->
            OutboundDraft("delivery-status", id, deliveryStatusBody(id, "dispatched", stamp, vehicle))
        }
    }

    /** Unsent messages that are due at [now], oldest first. A later message for an order waits for its earlier one. */
    @Synchronized
    fun dueOutbox(now: Long, limit: Int): List<OutboxItem> {
        if (!outboxScanned) scanOutbox()
        val items = mutableListOf<OutboxItem>()
        for (date in outboxDates.toList()) {
            val entry = runCatching { entry(date) }.getOrNull() ?: continue
            if (entry.outbox.none(Outbox::pending)) outboxDates -= date
            val waiting = mutableSetOf<String>()
            for (message in entry.outbox.filter(Outbox::pending)) {
                val order = message.path("orderId").asString()
                val due = message.path("nextAttemptAt").asLong() <= now
                if (due && order !in waiting && items.size < limit) {
                    items += OutboxItem(
                        date, message.path("messageId").asString(), message.path("kind").asString(),
                        copyObject(message.path("body") as ObjectNode), message.path("attempts").asInt(),
                    )
                }
                waiting += order
            }
        }
        return items
    }

    /** Stores what became of one send and returns the message's attempt count. Unknown messages are ignored. */
    @Synchronized
    fun recordOutbox(item: OutboxItem, outcome: OutboxOutcome, status: String, at: Long, next: Long): Int {
        val current = entry(item.date)
        val old = current.outbox.firstOrNull { it.path("messageId").asString() == item.messageId }
        // A slot switch can leave an old process with a stale cache. Reload instead of writing over a newer checkpoint.
        val onDisk = checkpoint(item.date)
        val stale = onDisk != null && onDisk.path("revision").asLong() != current.plan.revision
        if (stale) entries.remove(item.date)
        if (old == null || stale) return 0
        val updated = Outbox.withOutcome(old, outcome, status, at, next)
        val outbox = Outbox.retained(current.outbox.map { if (it === old) updated else it }, at)
        write(item.date, current.plan, current.results, outbox, current.etas, current.contentHash)
        entries[item.date] = current.copy(outbox = outbox)
        return updated.path("attempts").asInt()
    }

    /** The day JSON behind [date]'s orders (prepared CSV bundle or Meatbox orders), or null when there is none. */
    fun sourceDay(date: String): ByteArray? = runCatching { reader.sourceOf(date)?.raw }.getOrNull()

    @Synchronized
    fun outboxSummary(date: String, recent: Int): ObjectNode = Outbox.summary(date, entry(date).outbox, recent)

    // Once after a start: dates whose checkpoint still holds unsent messages. Later commits add dates themselves.
    private fun scanOutbox() {
        outboxScanned = true
        val names = Files.newDirectoryStream(stateDirectory, "*.json").use { files ->
            files.map { it.fileName.toString() }
        }
        for (name in names.filter { DATE_FILE.matches(it) }) {
            val bytes = runCatching { Files.readAllBytes(stateDirectory.resolve(name)) }.getOrNull() ?: continue
            val saved = runCatching { parse(bytes, "DISPATCH_STATE_INVALID") }.getOrNull()
            val owed = runCatching { Outbox.fromCheckpoint(saved) }.getOrDefault(emptyList())
            if (owed.any(Outbox::pending)) outboxDates += name.removeSuffix(".json")
        }
    }

    /**
     * Files one order message of Meatbox under its delivery date. A draft that the message invalidates is dropped
     * first (checkpoint, then orders): a failure between the two leaves the old orders without a draft, and the sender
     * retries. Writing the orders first would leave a checkpoint that names a source that no longer exists.
     */
    @Synchronized
    fun receiveOrder(order: InboundOrder): InboundReceipt {
        val orders = inbound ?: fail(HttpServletResponse.SC_NOT_FOUND, "NOT_FOUND")
        if (reader.hasCsvDate(order.deliveryDate)) {
            fail(HttpServletResponse.SC_CONFLICT, "SOURCE_CONFLICT", "이 날짜의 주문 원본은 준비된 자료입니다.")
        }
        val known = order.deliveryDate in orders.dates()
        val snapshot = if (known) entry(order.deliveryDate).plan.snapshot() else null
        val phase = snapshot?.path("dispatch")?.path("phase")?.asString() ?: "unplanned"
        val done = snapshot?.path("dispatchOrders")?.toList().orEmpty()
            .filter { it.path("status").asString() == "done" }.map { it.path("id").asString() }.toSet()
        val outcome = orders.plan(order, phase, done)
        val file = outcome.file ?: return outcome.receipt
        if (outcome.resetDraft) dropCheckpoint(order.deliveryDate)
        try {
            orders.write(file)
        } finally {
            entries.remove(order.deliveryDate)
        }
        return outcome.receipt
    }

    private fun dropCheckpoint(date: String) {
        verifyDirectory()
        try {
            Files.deleteIfExists(stateDirectory.resolve("$date.json"))
        } catch (_: IOException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
        }
        entries.remove(date)
    }

    @Synchronized
    fun result(date: String, requestId: String): ObjectNode {
        if (!CommandResults.validId(requestId)) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        val found = CommandResults.find(entry(date).results, requestId, clock())
            ?: fail(HttpServletResponse.SC_NOT_FOUND, "REQUEST_NOT_FOUND", "저장된 명령 결과가 없습니다.")
        return copyObject(found.response)
    }

    private fun requestId(command: ObjectNode): String? {
        val node = command.get("requestId") ?: return null
        if (!node.isString) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
        return node.asString().takeIf(CommandResults::validId)
            ?: fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_COMMAND")
    }

    private fun entry(date: String): Entry {
        verifyDirectory()
        // Read-only source bundle and current manifest remain the authority, even with a warm cache.
        val source = reader.sourceOf(date) ?: fail(HttpServletResponse.SC_NOT_FOUND, "DISPATCH_DATA_NOT_FOUND")
        val sourceId = source.sourceId
        val rawDay = source.raw
        val contentHash = sha256(rawDay)
        entries[date]?.let {
            if (it.sourceId != sourceId || it.contentHash != contentHash) {
                conflict(date, it.plan.exportCheckpoint().path("phase").asString(), it.sourceId, sourceId, contentHash)
            }
            return it
        }
        val day = parse(rawDay, "DISPATCH_DATA_INVALID")
        val saved = checkpoint(date)
        if (saved != null) verifyBinding(date, saved, sourceId, contentHash)
        val plan = try { DispatchPlan(day, sourceId, clock, saved) } catch (error: DispatchException) {
            if (saved == null) throw error
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
        }
        val results = CommandResults.fromCheckpoint(saved)
        val loaded = Entry(
            day, sourceId, plan, results, Outbox.fromCheckpoint(saved), source.api,
            Etas.fromCheckpoint(saved), contentHash,
        ).also { entries[date] = it }
        // Same source as before, so nothing shows that the content changed: the checkpoint is bound to it in place.
        if (saved != null && !saved.path("contentHash").isString) {
            runCatching { write(date, plan, loaded.results, loaded.outbox, loaded.etas, contentHash) }
                .onSuccess { log.info("Bound legacy dispatch checkpoint to its source content: date={}", date) }
        }
        return loaded
    }

    /** A saved checkpoint must name the source and, when it knows it, the content that the date has now. */
    private fun verifyBinding(date: String, saved: ObjectNode, sourceId: String, contentHash: String) {
        val savedSource = saved.path("sourceId").asString()
        val savedHash = saved.path("contentHash").takeIf { it.isString }?.asString()
        if (savedSource != sourceId || (savedHash != null && savedHash != contentHash)) {
            conflict(date, saved.path("phase").asString(), savedSource, sourceId, contentHash)
        }
    }

    private fun conflict(
        date: String,
        phase: String,
        expectedSource: String,
        actualSource: String,
        actualHash: String,
    ): Nothing {
        val reason = if (expectedSource != actualSource) "source" else "content"
        val key = "$actualSource/$actualHash"
        val since = conflictSince[date]?.takeIf { it.first == key } ?: (key to clock()).also {
            conflictSince[date] = it
            val first = SourceConflict(expectedSource, actualSource, phase, it.second, reason)
            runCatching { onSourceConflict?.invoke(date, first) }
        }
        throw SourceChangedException(SourceConflict(expectedSource, actualSource, phase, since.second, reason))
    }

    /**
     * An operator's answer to a source conflict. `keep-checkpoint` binds the saved plan to the date's current source
     * (refused once vehicles can run); `discard-checkpoint` moves the saved plan aside under a backup name and returns
     * the date to unplanned. Nothing is deleted, and nothing happens without a conflict to answer.
     */
    @Synchronized
    fun resolveSourceConflict(date: String, action: String, by: String): ObjectNode {
        if (action !in RESOLVE_ACTIONS) fail(HttpServletResponse.SC_BAD_REQUEST, "INVALID_ACTION")
        verifyDirectory()
        val source = reader.sourceOf(date) ?: fail(HttpServletResponse.SC_NOT_FOUND, "DISPATCH_DATA_NOT_FOUND")
        val contentHash = sha256(source.raw)
        val saved = checkpoint(date) ?: fail(HttpServletResponse.SC_CONFLICT, "NO_SOURCE_CONFLICT")
        val savedHash = saved.path("contentHash").takeIf { it.isString }?.asString()
        val moved = saved.path("sourceId").asString() != source.sourceId
        val edited = savedHash != null && savedHash != contentHash
        if (!moved && !edited) {
            fail(HttpServletResponse.SC_CONFLICT, "NO_SOURCE_CONFLICT", "이 날짜에는 해소할 원본 충돌이 없습니다.")
        }
        val phase = saved.path("phase").asString()
        val backup = if (action == "discard-checkpoint") {
            discardCheckpoint(date)
        } else {
            rebindCheckpoint(date, saved, source.sourceId, source.raw, contentHash)
            null
        }
        entries.remove(date)
        conflictSince.remove(date)
        log.info("Resolved dispatch source conflict: date={} action={} by={} phase={}", date, action, by, phase)
        return dispatchMapper.createObjectNode().apply {
            put("date", date)
            put("action", action)
            put("previousPhase", phase)
            if (backup != null) put("backup", backup) else putNull("backup")
        }
    }

    private fun rebindCheckpoint(
        date: String,
        saved: ObjectNode,
        sourceId: String,
        raw: ByteArray,
        contentHash: String,
    ) {
        val phase = saved.path("phase").asString()
        if (phase in OPERATING_PHASES) {
            fail(
                HttpServletResponse.SC_CONFLICT,
                "SOURCE_CHANGE_UNSAFE",
                "출발 가능한 배차는 새 원본에 다시 묶을 수 없습니다.",
            )
        }
        val rebound = copyObject(saved).apply { put("sourceId", sourceId) }
        val day = parse(raw, "DISPATCH_DATA_INVALID")
        val plan = try { DispatchPlan(day, sourceId, clock, rebound) } catch (_: DispatchException) {
            fail(
                HttpServletResponse.SC_CONFLICT,
                "SOURCE_CHANGE_INCOMPATIBLE",
                "저장된 배차가 새 원본과 맞지 않습니다.",
            )
        }
        write(
            date, plan, CommandResults.fromCheckpoint(rebound), Outbox.fromCheckpoint(rebound),
            Etas.fromCheckpoint(rebound), contentHash,
        )
    }

    private fun discardCheckpoint(date: String): String {
        val name = "$date.json.discarded-${BACKUP_STAMP.format(Instant.ofEpochMilli(clock()))}"
        try {
            val from = stateDirectory.resolve("$date.json")
            Files.move(from, stateDirectory.resolve(name), StandardCopyOption.ATOMIC_MOVE)
        } catch (_: IOException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
        }
        return name
    }

    private fun sha256(bytes: ByteArray): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun checkpoint(date: String): ObjectNode? {
        val path = stateDirectory.resolve("$date.json")
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return null
        val bytes = try {
            if (Files.size(path) > MAX_FILE_BYTES) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_INVALID",
            )
            stateFiles.readRequired(Path.of("$date.json"), false)
        } catch (_: IOException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
        } catch (_: DispatchDataException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
        }
        return parse(bytes, "DISPATCH_STATE_INVALID").also {
            val matches = it.path("schemaVersion").asInt() == CHECKPOINT_SCHEMA && it.path("date").asString() == date
            if (!matches || !it.path("sourceId").isString) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_INVALID",
            )
        }
    }

    private fun parse(bytes: ByteArray, code: String): ObjectNode {
        if (bytes.size > MAX_FILE_BYTES) fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, code)
        val parsed = runCatching { parser.readTree(bytes) }.getOrNull()
        return parsed as? ObjectNode ?: fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, code)
    }

    private fun save(date: String, checkpoint: ObjectNode) {
        val target = stateDirectory.resolve("$date.json")
        try {
            verifyDirectory()
            val unsafeTarget = Files.exists(target, LinkOption.NOFOLLOW_LINKS) &&
                !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)
            if (Files.isSymbolicLink(target) || unsafeTarget) {
                fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
            }
            val bytes = parser.writeValueAsBytes(checkpoint)
            if (bytes.size > MAX_FILE_BYTES) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_WRITE_FAILED",
            )
            writeAtomically(target, bytes)
        } catch (_: IOException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
        }
    }

    private fun verifyDirectory() {
        if (!Files.isDirectory(stateDirectory, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(stateDirectory)) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
        }
        var path = stateDirectory
        while (path.parent != null) {
            if (Files.isSymbolicLink(path)) fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
            path = path.parent
        }
    }

    private fun publicState(state: ObjectNode, entry: Entry): ObjectNode =
        state.put("boot", boot).also { overlayDriverLocations(it, locations) }.also {
            Etas.overlay(it, entry.etas)
        }.also {
            overlayTemperatures(it, temperatures, LocalDate.ofInstant(Instant.ofEpochMilli(clock()), SEOUL).toString())
        }.also {
            // Only dates fed by Meatbox carry this block, so prepared-CSV snapshots keep their bytes.
            if (entry.api) inbound?.summary(state.path("sourceData").path("date").asString())?.let { summary ->
                (state.path("sourceData") as ObjectNode).set("inbound", summary)
            }
        }

    private fun fail(
        status: Int,
        code: String, message: String = code): Nothing = throw DispatchException(status, code, message,
    )

    private data class Entry(
        val day: ObjectNode,
        val sourceId: String,
        val plan: DispatchPlan,
        val results: List<StoredResult> = emptyList(),
        val outbox: List<ObjectNode> = emptyList(),
        val api: Boolean = false,
        val etas: Map<String, ObjectNode> = emptyMap(),
        val contentHash: String = "",
    )

    companion object {
        private val log = LoggerFactory.getLogger(DispatchStore::class.java)
        private val RESOLVE_ACTIONS = setOf("keep-checkpoint", "discard-checkpoint")
        private val OPERATING_PHASES = setOf("published", "amending")
        private val BACKUP_STAMP = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmssSSS'Z'")
            .withZone(java.time.ZoneOffset.UTC)
        private const val CHECKPOINT_SCHEMA = 2
        private const val MAX_DATES = 2
        private const val MAX_FILE_BYTES = 16 * 1024 * 1024
        private val DATE_FILE = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}\\.json$")
    }
}

/**
 * One batch of operational commands, the messages that the resulting state owes Meatbox ([outbound]), the ETAs that
 * it sets per vehicle ([etas], computed from the engine snapshot) and the reply built from that state. [outbound] and
 * [respond] see the snapshot with the new ETAs laid over it.
 */
class CommandBatch(
    val steps: List<ObjectNode>,
    val outbound: (ObjectNode) -> List<OutboundDraft> = { emptyList() },
    val etas: (ObjectNode) -> Map<String, ObjectNode> = { emptyMap() },
    val respond: (ObjectNode) -> ObjectNode,
)

class BatchResult(val response: ObjectNode, val replayed: Boolean)
