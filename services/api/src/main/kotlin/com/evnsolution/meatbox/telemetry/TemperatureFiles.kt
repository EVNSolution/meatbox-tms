package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.integrations.meatbox.outbound.seoulStamp
import tools.jackson.databind.json.JsonMapper
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.stream.Collectors

internal val telemetryJson: JsonMapper = JsonMapper.builder().build()
private const val NEWLINE = '\n'.code.toByte()

/** The key by which a measurement counts as a repeat: same sensor, same second. */
internal fun Reading.key(): String = "$sensorId|${measuredAt.epochSecond}"

internal fun dayOf(instant: Instant): String = LocalDate.ofInstant(instant, SEOUL).toString()

/** One measurement per line, in the order the file keeps them: time, celsius, sensor, compartment, receive time. */
internal fun encode(reading: Reading, receivedAtMillis: Long): ByteArray {
    val line = telemetryJson.createObjectNode().put("t", seoulStamp(reading.measuredAt.toEpochMilli()))
        .put("c", reading.celsius).put("s", reading.sensorId)
    reading.compartment?.let { line.put("k", it) }
    line.put("r", receivedAtMillis)
    return telemetryJson.writeValueAsBytes(line) + NEWLINE
}

/** The part of [bytes] that ends with a newline. A crash in the middle of a write leaves a tail that is not a line. */
internal fun completeLines(bytes: ByteArray): ByteArray {
    val end = bytes.lastIndexOf(NEWLINE) + 1
    return if (end == bytes.size) bytes else bytes.copyOf(end)
}

/** Lines that do not parse are skipped, so one damaged line never hides the rest of a day. */
internal fun decode(bytes: ByteArray): List<Reading> = String(completeLines(bytes), Charsets.UTF_8).lineSequence()
    .filter { it.isNotBlank() }.mapNotNull { line ->
        runCatching {
            val node = telemetryJson.readTree(line)
            Reading(
                node.path("s").asString(),
                OffsetDateTime.parse(node.path("t").asString()).toInstant(),
                node.path("c").doubleValue(),
                node.get("k")?.asString(),
                node.path("r").asLong(0),
            )
        }.getOrNull()
    }.toList()

internal fun dayFile(vehicleDirectory: Path, day: String): Path = vehicleDirectory.resolve("$day.jsonl")

/** A symbolic link anywhere on the way would let a write leave the state directory. */
internal fun checkNoLinks(path: Path) {
    var cursor: Path? = path
    while (cursor != null) {
        check(!Files.isSymbolicLink(cursor))
        cursor = cursor.parent
    }
}

internal fun vehicleDirectories(root: Path): List<Path> {
    if (!Files.isDirectory(root, NOFOLLOW_LINKS)) return emptyList()
    return Files.list(root).use { stream ->
        stream.filter { Files.isDirectory(it, NOFOLLOW_LINKS) && TELEMETRY_ID.matches(it.fileName.toString()) }
            .collect(Collectors.toList())
    }
}

internal fun dayFiles(vehicleDirectory: Path): List<Path> = Files.list(vehicleDirectory).use { stream ->
    stream.filter { it.fileName.toString().endsWith(".jsonl") && Files.isRegularFile(it, NOFOLLOW_LINKS) }
        .sorted().collect(Collectors.toList())
}

internal fun Reading.toLatest(vehicleId: String, receivedAt: Instant) =
    Latest(vehicleId, sensorId, celsius, measuredAt, receivedAt, compartment)

/** Appends [bytes] to [file] and forces them to disk. A new file is readable by the service user only. */
internal fun appendBytes(file: Path, bytes: ByteArray) {
    check(!Files.isSymbolicLink(file))
    val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
    val options = setOf(StandardOpenOption.CREATE, StandardOpenOption.APPEND, NOFOLLOW_LINKS)
    FileChannel.open(file, options, permissions).use { channel ->
        val buffer = ByteBuffer.wrap(bytes)
        while (buffer.hasRemaining()) channel.write(buffer)
        channel.force(true)
    }
}
