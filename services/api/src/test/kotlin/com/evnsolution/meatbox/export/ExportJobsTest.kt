package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.integrations.meatbox.inbound.INBOUND_DATE
import com.evnsolution.meatbox.integrations.meatbox.inbound.InboundOrders
import com.evnsolution.meatbox.integrations.meatbox.inbound.order
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Duration
import java.time.Instant
import java.util.ArrayDeque
import java.util.concurrent.Executor
import java.util.zip.ZipFile

class ExportJobsTest {
    @TempDir lateinit var temp: Path

    private val now = Instant.parse("2026-10-14T01:00:00Z")
    private val state get() = temp.toRealPath().resolve("state")
    private val queue = ArrayDeque<Runnable>()
    private val manual = Executor { queue.add(it) }

    private val shared: ExportWriter by lazy { build() }

    private fun writer() = shared

    private fun build(): ExportWriter {
        val orders = InboundOrders(Files.createDirectories(state.resolve("inbound")), 4) { now.toEpochMilli() }
        orders.write(orders.plan(order("A"), "unplanned", emptySet()).file!!)
        orders.write(orders.plan(order("B"), "unplanned", emptySet()).file!!)
        return ExportWriter(ExportSources(state, null, { null }, { null }), "test", "abc") { now }
    }

    private fun jobs(writer: ExportWriter = writer(), free: Long = Long.MAX_VALUE) =
        ExportJobs(state.resolve("exports"), writer, manual, { now }) { free }

    private fun code(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private val all get() = ExportRequest.of(null, null, null)

    @Test
    fun `runs one export at a time and answers a second with 409 until the first ends`() {
        val jobs = jobs()
        val first = jobs.start(all, "alice")
        assertThat(first.state).isEqualTo("running")
        code(409, "EXPORT_IN_PROGRESS") { jobs.start(all, "bob") }
        code(409, "EXPORT_NOT_READY") { jobs.archive(first.id) }

        queue.remove().run()
        assertThat(jobs.get(first.id).state).isEqualTo("done")
        val second = jobs.start(all, "bob")
        assertThat(second.id).isNotEqualTo(first.id)
    }

    @Test
    fun `a finished job reports size and sha256 of its archive and survives a restart`() {
        val jobs = jobs()
        val job = jobs.start(all, "alice")
        queue.remove().run()

        val done = jobs.get(job.id)
        val file = jobs.archive(job.id)
        assertThat(done.bytes).isEqualTo(Files.size(file))
        assertThat(done.sha256).isEqualTo(sha256(Files.readAllBytes(file)))
        assertThat(done.requestedBy).isEqualTo("alice")
        ZipFile(file.toFile()).use { zip ->
            assertThat(zip.entries().toList().map { it.name }).contains("orders/$INBOUND_DATE.json", "manifest.json")
        }

        val restarted = jobs()
        assertThat(restarted.get(job.id).sha256).isEqualTo(done.sha256)
        assertThat(restarted.list().map { it.id }).containsExactly(job.id)
    }

    @Test
    fun `answers 507 when the free disk is under twice the size of the files, and stays usable`() {
        val writer = writer()
        val size = writer.estimate(all)
        assertThat(size).isPositive()
        code(507, "EXPORT_DISK_SPACE") { jobs(writer, free = size * 2 - 1).start(all, "alice") }
        val jobs = jobs(writer, free = size * 2)
        code(507, "EXPORT_DISK_SPACE") { jobs(writer, free = 0).start(all, "alice") }
        assertThat(jobs.start(all, "alice").state).isEqualTo("running")
    }

    @Test
    fun `answers 404 for an id that is unknown, malformed or a path`() {
        val jobs = jobs()
        jobs.start(all, "alice")
        for (id in listOf("00000000-0000-4000-8000-000000000000", "nope", "../state", "..%2f")) {
            code(404, "EXPORT_NOT_FOUND") { jobs.get(id) }
            code(404, "EXPORT_NOT_FOUND") { jobs.archive(id) }
        }
    }

    @Test
    fun `purge removes archives and records older than seven days and keeps newer ones`() {
        val jobs = jobs()
        val old = jobs.start(all, "alice").also { queue.remove().run() }
        val fresh = jobs.start(all, "alice").also { queue.remove().run() }
        val directory = state.resolve("exports")
        val aged = FileTime.from(now.minus(EXPORT_RETENTION).minus(Duration.ofMinutes(1)))
        listOf("${old.id}.zip", "${old.id}.json").forEach { Files.setLastModifiedTime(directory.resolve(it), aged) }

        jobs.purge()

        assertThat(Files.list(directory).use { s -> s.map { it.fileName.toString() }.toList() })
            .containsExactlyInAnyOrder("${fresh.id}.zip", "${fresh.id}.json")
        code(404, "EXPORT_NOT_FOUND") { jobs.get(old.id) }
        assertThat(jobs.get(fresh.id).state).isEqualTo("done")
    }

    @Test
    fun `the command line writes the archive and prints path, size and hash`() {
        val target = temp.toRealPath().resolve("cli.zip")
        val out = ByteArrayOutputStream()
        ExportRunner(writer(), target.toString(), "", "", "orders", "none").execute(PrintStream(out))

        val (path, size, hash) = out.toString().trim().split(' ')
        assertThat(path).isEqualTo(target.toString())
        assertThat(size.toLong()).isEqualTo(Files.size(target))
        assertThat(hash).isEqualTo(sha256(Files.readAllBytes(target)))
        ZipFile(target.toFile()).use { zip ->
            val manifest = zip.getInputStream(zip.getEntry("manifest.json")).readAllBytes()
            assertThat(String(manifest)).contains("\"orders\" : 2")
        }
    }

    @Test
    fun `the command line refuses a running server, a relative path and an existing file`() {
        val target = temp.toRealPath().resolve("cli.zip")
        val writer = writer()
        fun run(out: String, type: String) =
            ExportRunner(writer, out, "", "", "", type).execute(PrintStream(ByteArrayOutputStream()))
        assertThatThrownBy { run(target.toString(), "servlet") }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { run("cli.zip", "none") }.isInstanceOf(IllegalArgumentException::class.java)
        Files.writeString(target, "keep")
        assertThatThrownBy { run(target.toString(), "none") }
            .isInstanceOf(java.nio.file.FileAlreadyExistsException::class.java)
        assertThat(Files.readString(target)).isEqualTo("keep")
    }
}
