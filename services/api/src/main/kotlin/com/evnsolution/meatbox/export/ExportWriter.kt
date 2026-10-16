package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import com.evnsolution.meatbox.telemetry.completeLines
import com.evnsolution.meatbox.telemetry.vehicleDirectories
import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.time.Instant
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal const val EXPORT_SCHEMA_VERSION = 1
private const val COPY_BUFFER = 64 * 1024
private val DATE_FILE = Regex("^([0-9]{4}-[0-9]{2}-[0-9]{2})\\.json$")
private val DRIVER_FILE = Regex("^driver-([0-9]{4}-[0-9]{2}-[0-9]{2})\\.json$")
private val DAY_LINES = Regex("^([0-9]{4}-[0-9]{2}-[0-9]{2})\\.jsonl$")
private val DATE_NAME = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
private val PHOTO_FILE = Regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.(jpg|png)$")
private val EVENT_KEYS = listOf("eventId", "type", "vehicleId", "stopId", "occurredAt")
private val COUNT_KEYS = listOf(
    "orders", "dispatchDates", "driverDates", "photos", "telemetryReadings", "vehicles", "regionCodes",
)

/** What the archive is built from. Everything but [state] is read through these, so the writer owns no store. */
class ExportSources(
    val state: Path,
    val resourceDatabase: Path?,
    val sourceDay: (String) -> ByteArray?,
    val snapshot: (String) -> ObjectNode?,
)

private class Item(
    val name: String,
    val size: Long = 0,
    val file: Path? = null,
    val stream: Boolean = false,
    val make: (ByteArray?) -> ByteArray? = { it },
)

private class Written(val name: String, val size: Long, val sha256: String, val changed: Boolean)

private class Body(val length: Long, val sha256: String, val trimmed: Boolean, val content: ByteArray?)

/**
 * Builds one ZIP archive of the state directory (see docs/data-export-format.md). It never locks the stores: every
 * state file is replaced atomically or only appended to, so each file is read once as it was at one moment, and a
 * file whose size or modification time moved during its read is marked `changedDuringExport` in the manifest.
 */
@Suppress("TooManyFunctions")
class ExportWriter(
    private val sources: ExportSources,
    private val serverVersion: String,
    private val serverCommit: String,
    private val clock: () -> Instant = Instant::now,
) {
    private val warnings = mutableListOf<String>()

    /** The bytes that the files of [request] hold now. Archive size stays below this for JSON and text. */
    fun estimate(request: ExportRequest): Long = plan(request).sumOf { it.size }

    /** Writes the archive to [target], which must not exist, and returns its manifest. */
    @Synchronized
    fun write(request: ExportRequest, target: Path): ObjectNode {
        warnings.clear()
        val files = mutableListOf<Written>()
        val counts = COUNT_KEYS.associateWith { 0L }.toMutableMap()
        val options = arrayOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        ZipOutputStream(BufferedOutputStream(Files.newOutputStream(target, *options))).use { zip ->
            for (item in plan(request)) {
                val written = add(zip, item, counts) ?: continue
                files += written
            }
            val manifest = manifest(request, files, counts)
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(exportJson.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest))
            zip.closeEntry()
            return manifest
        }
    }

    private fun manifest(request: ExportRequest, files: List<Written>, counts: Map<String, Long>): ObjectNode =
        exportJson.createObjectNode().apply {
            put("schemaVersion", EXPORT_SCHEMA_VERSION)
            put("exportedAt", seoulStamp(clock().toEpochMilli()))
            put("timezone", "Asia/Seoul")
            put("serverVersion", serverVersion)
            put("serverCommit", serverCommit)
            putObject("range").put("from", request.from).put("to", request.to)
            putArray("include").also { list -> request.include.forEach(list::add) }
            putObject("counts").also { out -> counts.forEach { (key, value) -> out.put(key, value) } }
            putArray("files").also { list ->
                files.sortedBy(Written::name).forEach {
                    list.addObject().put("path", it.name).put("size", it.size).put("sha256", it.sha256)
                        .apply { if (it.changed) put("changedDuringExport", true) }
                }
            }
            putArray("warnings").also { list -> warnings.forEach(list::add) }
        }

    private fun add(zip: ZipOutputStream, item: Item, counts: MutableMap<String, Long>): Written? {
        val before = item.file?.let(::stamp)
        val body = (if (item.stream) streamed(zip, item) else buffered(zip, item)) ?: return null
        val changed = body.trimmed || (before != null && stamp(item.file!!) != before)
        tally(item.name, body.content, counts)
        return Written(item.name, body.length, body.sha256, changed)
    }

    private fun buffered(zip: ZipOutputStream, item: Item): Body? {
        val raw = item.file?.let { read(it, item.name) }
        val missing = item.file != null && raw == null
        val made = if (missing) null else item.make(raw)
        if (made == null) {
            if (!missing) warnings += "${item.name}: unavailable"
            return null
        }
        val content = if (item.name.endsWith(".jsonl")) completeLines(made) else made
        zip.putNextEntry(ZipEntry(item.name))
        zip.write(content)
        zip.closeEntry()
        val sha256 = hex(MessageDigest.getInstance("SHA-256").digest(content))
        return Body(content.size.toLong(), sha256, content.size != made.size, content)
    }

    private fun streamed(zip: ZipOutputStream, item: Item): Body? {
        val input = try {
            Files.newInputStream(item.file!!)
        } catch (_: NoSuchFileException) {
            warnings += "${item.name}: removed before it was read"
            return null
        }
        val digest = MessageDigest.getInstance("SHA-256")
        zip.putNextEntry(ZipEntry(item.name))
        val length = input.use { copy(it, zip, digest) }
        zip.closeEntry()
        return Body(length, hex(digest.digest()), false, null)
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private fun read(file: Path, name: String): ByteArray? = try {
        Files.readAllBytes(file)
    } catch (_: NoSuchFileException) {
        warnings += "$name: removed before it was read"
        null
    }

    private fun copy(input: InputStream, zip: ZipOutputStream, digest: MessageDigest): Long {
        val buffer = ByteArray(COPY_BUFFER)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return total
            zip.write(buffer, 0, read)
            digest.update(buffer, 0, read)
            total += read
        }
    }

    private fun stamp(file: Path): Pair<Long, Long>? = try {
        Files.readAttributes(file, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
            .let { it.size() to it.lastModifiedTime().toMillis() }
    } catch (_: IOException) {
        null
    }

    private fun tally(name: String, content: ByteArray?, counts: MutableMap<String, Long>) {
        fun add(key: String, value: Long) { counts[key] = counts.getValue(key) + value }
        when {
            name.startsWith("orders/") -> add("orders", listSize(content, "order"))
            name.startsWith("dispatch/") && !name.endsWith(".summary.json") -> add("dispatchDates", 1)
            name.startsWith("driver/") -> add("driverDates", 1)
            name.startsWith("photos/") && name != "photos/index.json" -> add("photos", 1)
            name.endsWith(".jsonl") -> add("telemetryReadings", content!!.count { it == '\n'.code.toByte() }.toLong())
            name == "resources/vehicles.json" -> add("vehicles", listSize(content, "vehicles"))
            name == "resources/region-codes.json" -> add("regionCodes", listSize(content, "regionCodes"))
        }
    }

    private fun listSize(content: ByteArray?, field: String) = exportJson.readTree(content).path(field).size().toLong()

    private fun plan(request: ExportRequest): List<Item> = buildList {
        if (request.has("orders")) addAll(orders(request))
        if (request.has("dispatch")) addAll(dispatch(request))
        if (request.has("driver")) addAll(driver(request))
        if (request.has("photos")) addAll(photos(request))
        if (request.has("telemetry")) addAll(telemetry(request))
        if (request.has("resources")) addAll(resources())
    }

    private fun orders(request: ExportRequest) = dated(sources.state.resolve("inbound"), DATE_FILE, request).map {
        Item("orders/${it.first}.json", size(it.second), it.second)
    }

    private fun dispatch(request: ExportRequest): List<Item> {
        val checkpoints = dated(sources.state, DATE_FILE, request)
        val received = dated(sources.state.resolve("inbound"), DATE_FILE, request)
        val dates = (checkpoints + received).map { it.first }.toSortedSet()
        return checkpoints.flatMap { (date, file) ->
            listOf(
                Item("dispatch/$date.json", size(file), file),
                Item("dispatch/$date.summary.json", make = { summaryOf(date) }),
            )
        } + dates.map { date -> Item("source/$date.json", make = { sources.sourceDay(date) }) }
    }

    private fun summaryOf(date: String): ByteArray? {
        val snapshot = runCatching { sources.snapshot(date) }.getOrNull() ?: return null
        val events = driverState(date)?.path("events")?.toList().orEmpty()
        return exportJson.writerWithDefaultPrettyPrinter().writeValueAsBytes(summarize(date, snapshot, events))
    }

    private fun driverState(date: String): JsonNode? =
        runCatching { exportJson.readTree(Files.readAllBytes(sources.state.resolve("driver-$date.json"))) }.getOrNull()

    private fun driver(request: ExportRequest) = dated(sources.state, DRIVER_FILE, request).map { (date, file) ->
        Item("driver/$date.json", size(file), file, make = { raw -> raw?.let(::withoutSecrets) })
    }

    /** Device registrations keep only the vehicle and platform: tokens, session digests and user names stay behind. */
    private fun withoutSecrets(raw: ByteArray): ByteArray? {
        val state = runCatching { exportJson.readTree(raw) as? ObjectNode }.getOrNull() ?: return null
        val devices = exportJson.createArrayNode()
        state.path("devices").forEach { device ->
            devices.addObject().put("vehicleId", device.path("vehicleId").asString(""))
                .put("platform", device.path("platform").asString(""))
        }
        state.set("devices", devices)
        return exportJson.writerWithDefaultPrettyPrinter().writeValueAsBytes(state)
    }

    private fun photos(request: ExportRequest): List<Item> {
        val root = sources.state.resolve("photos")
        val byDate = children(root).mapNotNull { dir ->
            val date = dir.fileName.toString()
            if (!DATE_NAME.matches(date) || !request.inRange(date) || !Files.isDirectory(dir, NOFOLLOW_LINKS)) null
            else date to children(dir).filter { PHOTO_FILE.matches(it.fileName.toString()) && regular(it) }
        }.sortedBy { it.first }
        val items = byDate.flatMap { (date, files) ->
            files.map { Item("photos/$date/${it.fileName}", size(it), it, stream = true) }
        }
        return if (byDate.isEmpty()) items else items + Item("photos/index.json", make = { photoIndex(byDate) })
    }

    private fun photoIndex(byDate: List<Pair<String, List<Path>>>): ByteArray {
        val index = exportJson.createArrayNode()
        for ((date, files) in byDate) {
            val onDisk = files.associateBy { it.fileName.toString().substringBefore('.') }
            val referenced = mutableSetOf<String>()
            driverState(date)?.path("events")?.forEach { event ->
                event.path("photoIds").forEach { id ->
                    val photoId = id.asString()
                    referenced += photoId
                    index.add(photoEntry(date, photoId, onDisk[photoId], event))
                }
            }
            onDisk.filterKeys { it !in referenced }.forEach { (id, file) ->
                index.add(photoEntry(date, id, file, null))
            }
        }
        val document = exportJson.createObjectNode().set("photos", index)
        return exportJson.writerWithDefaultPrettyPrinter().writeValueAsBytes(document)
    }

    private fun photoEntry(date: String, photoId: String, file: Path?, event: JsonNode?): ObjectNode =
        exportJson.createObjectNode().apply {
            put("photoId", photoId)
            put("date", date)
            if (file != null) put("file", "photos/$date/${file.fileName}") else putNull("file")
            if (event != null) {
                EVENT_KEYS.forEach { put(it, event.path(it).asString("")) }
                set("orderIds", event.path("orderIds").takeIf(JsonNode::isArray) ?: exportJson.createArrayNode())
            } else putNull("eventId")
        }

    private fun telemetry(request: ExportRequest): List<Item> {
        val root = sources.state.resolve("telemetry")
        val items = vehicleDirectories(root).sortedBy { it.fileName.toString() }.flatMap { directory ->
            val vehicle = directory.fileName.toString()
            val days = dated(directory, DAY_LINES, request).map { (date, file) ->
                Item("telemetry/$vehicle/$date.jsonl", size(file), file)
            }
            val outbox = directory.resolve("outbox.json").takeIf(::regular)?.let {
                Item("telemetry/$vehicle/outbox.json", size(it), it)
            }
            days + listOfNotNull(outbox)
        }
        val ranges = root.resolve("ranges.json").takeIf(::regular)?.let {
            Item("telemetry/ranges.json", size(it), it)
        }
        return items + listOfNotNull(ranges)
    }

    private fun resources(): List<Item> {
        val database = sources.resourceDatabase?.takeIf(::regular) ?: return emptyList()
        val registry = lazy { runCatching { readRegistry(database) }.getOrNull() }
        return listOf(
            Item("resources/vehicles.json", make = { registry.value?.first }),
            Item("resources/region-codes.json", make = { registry.value?.second }),
        )
    }

    private fun dated(directory: Path, pattern: Regex, request: ExportRequest) =
        children(directory).filter { regular(it) }.mapNotNull { file ->
            val date = pattern.matchEntire(file.fileName.toString())?.groupValues?.get(1)
            date?.takeIf(request::inRange)?.let { it to file }
        }.sortedBy { it.first }

    private fun children(directory: Path): List<Path> = try {
        if (!Files.isDirectory(directory, NOFOLLOW_LINKS)) emptyList()
        else Files.list(directory).use { stream -> stream.sorted().toList() }
    } catch (error: IOException) {
        warnings += "${directory.fileName}: not listed (${error.javaClass.simpleName})"
        emptyList()
    }

    private fun regular(file: Path) = Files.isRegularFile(file, NOFOLLOW_LINKS)

    private fun size(file: Path): Long = runCatching { Files.size(file) }.getOrDefault(0)
}
