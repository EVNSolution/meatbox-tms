package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.dispatch.writeAtomically
import org.slf4j.LoggerFactory
import tools.jackson.databind.node.ObjectNode
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

private const val CONFLICT = 409
private const val NOT_FOUND = 404
private const val INSUFFICIENT_STORAGE = 507
private const val UNAVAILABLE = 503
private const val SPACE_FACTOR = 2
private const val HASH_BUFFER = 64 * 1024
private val JOB_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

/** How long a finished archive stays on disk before the purge removes it. */
val EXPORT_RETENTION: Duration = Duration.ofDays(7)

private val log = LoggerFactory.getLogger("com.evnsolution.meatbox.export.Jobs")

/** One export as the operator sees it. [state] is `running`, `done` or `failed`. */
class ExportJob(
    val id: String,
    val state: String,
    val requestedBy: String,
    val createdAt: Instant,
    val from: String?,
    val to: String?,
    val include: Set<String>,
    val finishedAt: Instant? = null,
    val bytes: Long? = null,
    val sha256: String? = null,
    val error: String? = null,
)

/**
 * Runs one export at a time into `{directory}/{jobId}.zip` and remembers each result in `{jobId}.json` beside it, so
 * a finished archive can still be found after a restart. A second request while one runs is a 409; too little free
 * disk (under [SPACE_FACTOR] times the files' size) is a 507 before anything is written.
 */
@Suppress("TooManyFunctions")
class ExportJobs(
    private val directory: Path,
    private val writer: ExportWriter,
    private val executor: Executor,
    private val clock: () -> Instant = Instant::now,
    private val freeSpace: (Path) -> Long = { Files.getFileStore(it).usableSpace },
) {
    private val running = AtomicBoolean(false)
    private val jobs = java.util.concurrent.ConcurrentHashMap<String, ExportJob>()

    @Suppress("TooGenericExceptionCaught")
    fun start(request: ExportRequest, user: String): ExportJob {
        prepare()
        if (!running.compareAndSet(false, true)) {
            throw DispatchException(CONFLICT, "EXPORT_IN_PROGRESS", "Another export is running.")
        }
        try {
            purge()
            requireSpace(request)
            val job = ExportJob(
                UUID.randomUUID().toString(), "running", user, clock(), request.from, request.to, request.include,
            )
            jobs[job.id] = job
            log.info(
                "EXPORT_START job={} user={} from={} to={} include={}",
                job.id, user, request.from, request.to, request.include,
            )
            executor.execute { run(job, request) }
            return job
        } catch (error: Throwable) {
            running.set(false)
            throw error
        }
    }

    private fun requireSpace(request: ExportRequest) {
        if (freeSpace(directory) < writer.estimate(request) * SPACE_FACTOR) {
            throw DispatchException(INSUFFICIENT_STORAGE, "EXPORT_DISK_SPACE", "Not enough free disk for this export.")
        }
    }

    fun get(id: String): ExportJob {
        val known = JOB_ID.matches(id) && (jobs[id] ?: stored(id)) != null
        if (!known) throw DispatchException(NOT_FOUND, "EXPORT_NOT_FOUND", "No such export.")
        return jobs[id] ?: stored(id)!!
    }

    fun list(): List<ExportJob> {
        val saved = runCatching {
            Files.list(directory).use { stream ->
                stream.map { it.fileName.toString() }.filter { it.endsWith(".json") }
                    .map { it.removeSuffix(".json") }.filter(JOB_ID::matches).toList()
            }
        }.getOrDefault(emptyList())
        val known = saved.mapNotNull(::stored).associateBy { it.id } + jobs
        return known.values.sortedByDescending { it.createdAt }
    }

    /** The finished archive of [id]; a job that is not `done` has none. */
    fun archive(id: String): Path {
        val job = get(id)
        if (job.state != "done") throw DispatchException(CONFLICT, "EXPORT_NOT_READY", "The export has no archive.")
        return directory.resolve("$id.zip")
    }

    /** Removes files that are older than [EXPORT_RETENTION]. A job that is still running is never old enough. */
    fun purge() {
        val limit = clock().minus(EXPORT_RETENTION)
        runCatching {
            Files.list(directory).use { stream ->
                stream.filter { Files.getLastModifiedTime(it).toInstant().isBefore(limit) }.toList()
            }
        }.getOrDefault(emptyList()).forEach { file ->
            if (runCatching { Files.deleteIfExists(file) }.getOrDefault(false)) {
                jobs.remove(file.fileName.toString().substringBefore('.'))
            }
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun run(job: ExportJob, request: ExportRequest) {
        val part = directory.resolve("${job.id}.zip.part")
        val target = directory.resolve("${job.id}.zip")
        val result = try {
            writer.write(request, part)
            Files.move(part, target, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
            val (bytes, hash) = digest(target)
            log.info("EXPORT_DONE job={} bytes={}", job.id, bytes)
            finish(job, "done", bytes, hash, null)
        } catch (error: Exception) {
            runCatching { Files.deleteIfExists(part) }
            log.warn("EXPORT_FAILED job={} {}", job.id, error.javaClass.simpleName)
            finish(job, "failed", null, null, error.javaClass.simpleName)
        }
        jobs[job.id] = result
        runCatching { writeAtomically(directory.resolve("${job.id}.json"), meta(result)) }
        running.set(false)
    }

    private fun finish(job: ExportJob, state: String, bytes: Long?, hash: String?, error: String?) = ExportJob(
        job.id, state, job.requestedBy, job.createdAt, job.from, job.to, job.include, clock(), bytes, hash, error,
    )

    private fun digest(file: Path): Pair<Long, String> {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(HASH_BUFFER)
        var total = 0L
        Files.newInputStream(file).use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                total += read
            }
        }
        return total to digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun prepare() {
        try {
            val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))
            Files.createDirectories(directory, permissions)
            check(!Files.isSymbolicLink(directory) && Files.isDirectory(directory, NOFOLLOW_LINKS))
        } catch (_: IOException) {
            throw DispatchException(UNAVAILABLE, "EXPORT_UNAVAILABLE", "The export directory cannot be used.")
        }
    }

    private fun meta(job: ExportJob): ByteArray = exportJson.writeValueAsBytes(exportJson.createObjectNode().apply {
        put("id", job.id).put("state", job.state).put("requestedBy", job.requestedBy)
        put("createdAt", job.createdAt.toString())
        put("from", job.from).put("to", job.to)
        putArray("include").also { list -> job.include.forEach(list::add) }
        put("finishedAt", job.finishedAt?.toString())
        job.bytes?.let { put("bytes", it) }
        put("sha256", job.sha256).put("error", job.error)
    })

    private fun stored(id: String): ExportJob? = runCatching {
        val node = exportJson.readTree(Files.readAllBytes(directory.resolve("$id.json"))) as ObjectNode
        fun text(name: String) = node.path(name).asString(null)
        ExportJob(
            text("id"), text("state"), text("requestedBy"), Instant.parse(text("createdAt")), text("from"), text("to"),
            node.path("include").toList().map { it.asString() }.toSet(),
            text("finishedAt")?.let(Instant::parse),
            node.path("bytes").takeIf { it.isNumber }?.asLong(), text("sha256"), text("error"),
        )
    }.getOrNull()
}
