package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.compat.DispatchDataReader
import com.evnsolution.meatbox.compat.SafeSourceFiles
import com.evnsolution.meatbox.compat.DispatchDataException
import jakarta.servlet.http.HttpServletResponse
import java.io.IOException
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

// One lock and one file per date keep every command atomic; splitting the store would expose its internals.
@Suppress("TooManyFunctions")
class DispatchStore(
    private val reader: DispatchDataReader,
    private val stateDirectory: Path,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val boot: String = UUID.randomUUID().toString()

    /** Set by the driver module. It must answer without taking any lock that waits for this store. */
    @Volatile var locations: DriverLocationSource? = null
    private val parser = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()
    private val stateFiles = SafeSourceFiles(stateDirectory)
    // ponytail: one service-wide lock; use per-date locks if measured throughput requires them.
    private val entries = object : LinkedHashMap<String, Entry>(4, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>): Boolean = size > MAX_DATES
    }

    @Synchronized
    fun snapshot(date: String): ObjectNode = publicState(entry(date).plan.snapshot())

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
        output.set("state", publicState(output.path("state") as ObjectNode))
        commit(date, current, candidate, requestId, hash, output)
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
        val planned = prepare(candidate.snapshot())
        planned.steps.forEach { candidate.command(copyObject(it).put("expectedRevision", candidate.revision)) }
        val response = planned.respond(candidate.snapshot())
        commit(date, current, candidate, requestId, hash, response)
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
    ) {
        val results = if (requestId == null) current.results else CommandResults.retained(
            current.results + StoredResult(requestId, hash!!, clock(), copyObject(output)), clock(),
        )
        // One file write carries the new state and its result, so neither can exist without the other.
        save(date, candidate.exportCheckpoint().also { checkpoint ->
            if (results.isNotEmpty()) checkpoint.set("commandResults", CommandResults.toNode(results))
        })
        entries[date] = current.copy(plan = candidate, results = results)
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
        val manifest = reader.loadManifest()
        if (date !in manifest.dates) fail(HttpServletResponse.SC_NOT_FOUND, "DISPATCH_DATA_NOT_FOUND")
        val sourceId = manifest.node.path("source").path("csvSha256").asString("")
        val rawDay = reader.readDay(date)
        entries[date]?.let {
            if (it.sourceId != sourceId) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_SOURCE_MISMATCH",
            )
            return it
        }
        val day = parse(rawDay, "DISPATCH_DATA_INVALID")
        val saved = checkpoint(date, sourceId)
        val plan = try { DispatchPlan(day, sourceId, clock, saved) } catch (error: DispatchException) {
            if (saved == null) throw error
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_INVALID")
        }
        return Entry(day, sourceId, plan, CommandResults.fromCheckpoint(saved)).also { entries[date] = it }
    }

    private fun checkpoint(date: String, sourceId: String): ObjectNode? {
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
            if (it.path("sourceId").asString() != sourceId) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_SOURCE_MISMATCH",
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
        val temporary = stateDirectory.resolve(".$date.${UUID.randomUUID()}.tmp")
        try {
            verifyDirectory()
            val unsafeTarget = Files.exists(target, LinkOption.NOFOLLOW_LINKS) &&
                !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)
            if (Files.isSymbolicLink(target) || unsafeTarget) {
                fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
            }
            val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
            val bytes = parser.writeValueAsBytes(checkpoint)
            if (bytes.size > MAX_FILE_BYTES) fail(
                HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                "DISPATCH_STATE_WRITE_FAILED",
            )
            val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
            FileChannel.open(temporary, options, permissions).use {
                val buffer = ByteBuffer.wrap(bytes)
                while (buffer.hasRemaining()) it.write(buffer)
                it.force(true)
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: IOException) {
            fail(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "DISPATCH_STATE_WRITE_FAILED")
        } finally {
            // A cleanup failure after atomic replacement must not report a failed commit.
            runCatching { Files.deleteIfExists(temporary) }
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

    private fun publicState(state: ObjectNode): ObjectNode =
        state.put("boot", boot).also { overlayDriverLocations(it, locations) }

    private fun fail(
        status: Int,
        code: String, message: String = code): Nothing = throw DispatchException(status, code, message,
    )

    private data class Entry(
        val day: ObjectNode,
        val sourceId: String,
        val plan: DispatchPlan,
        val results: List<StoredResult> = emptyList(),
    )

    companion object {
        private const val CHECKPOINT_SCHEMA = 2
        private const val MAX_DATES = 2
        private const val MAX_FILE_BYTES = 16 * 1024 * 1024
    }
}

/** One batch of operational commands plus the reply built from the state they produce. */
class CommandBatch(val steps: List<ObjectNode>, val respond: (ObjectNode) -> ObjectNode)

class BatchResult(val response: ObjectNode, val replayed: Boolean)
