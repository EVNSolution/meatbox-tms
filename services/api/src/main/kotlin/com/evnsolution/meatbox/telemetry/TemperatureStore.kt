package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.driver.DriverFileLock
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap

private const val SERVICE_UNAVAILABLE = 503
private const val CONFLICT = 409
private const val MAX_LINES_PER_DAY = 100_000
private const val MAX_INDEXES = 64
private const val INDEX_CAPACITY = 16
private val DEFAULT_STALE: Duration = Duration.ofMinutes(10)
private const val LOAD_FACTOR = 0.75f

/** The newest measurement of one sensor, and when the service last stored anything new for it. */
data class Latest(
    val vehicleId: String,
    val sensorId: String,
    val celsius: Double,
    val measuredAt: Instant,
    val receivedAt: Instant,
    val compartment: String?,
)

class Receipt(val accepted: Int, val duplicate: Int, val fresh: List<Reading>)

/** The keys already in one day file, so a repeated measurement is found without reading the file again. */
private class DayIndex(var size: Long, val keys: MutableSet<String>) {
    val lines: Int get() = keys.size
}

/**
 * Measurements of every vehicle, one append-only file per vehicle and day: `{directory}/{vehicleId}/{yyyy-MM-dd}.jsonl`
 * (the day of the measurement, in Seoul). The files belong to neither the date checkpoints nor the driver state; they
 * are a time series that nothing deletes. A write holds this process's monitor and an OS lock, because a second
 * service process may share the directory during a blue/green switch.
 */
class TemperatureStore(
    private val directory: Path,
    private val clock: () -> Instant = Instant::now,
    val staleAfter: Duration = DEFAULT_STALE,
) {
    private val fileLock = DriverFileLock(directory.resolve(".telemetry.lock"), "TELEMETRY_BUSY")
    private val indexes = object : LinkedHashMap<Pair<String, String>, DayIndex>(INDEX_CAPACITY, LOAD_FACTOR, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Pair<String, String>, DayIndex>) =
            size > MAX_INDEXES
    }
    private val newest = ConcurrentHashMap<Pair<String, String>, Latest>()

    init {
        runCatching { seed() }
    }

    /** Stores what is new. A measurement of the same sensor and second that is already stored is a repeat. */
    @Synchronized
    fun ingest(batch: Batch): Receipt = try {
        prepare(batch.vehicleId)
        fileLock.withLock { write(batch) }
    } catch (error: IOException) {
        throw DispatchException(SERVICE_UNAVAILABLE, "TELEMETRY_WRITE_FAILED", "TELEMETRY_WRITE_FAILED", error)
    }

    private fun write(batch: Batch): Receipt {
        val vehicleDirectory = directory.resolve(batch.vehicleId)
        val now = clock()
        val seen = HashSet<String>()
        val plan = batch.readings.groupBy { dayOf(it.measuredAt) }.map { (day, readings) ->
            val index = index(batch.vehicleId, day)
            val fresh = readings.filter { it.key() !in index.keys && seen.add(it.key()) }
            // Every day is checked before the first one is written, so a batch is stored whole or not at all.
            if (index.lines + fresh.size > MAX_LINES_PER_DAY) telemetryFail(CONFLICT, "TELEMETRY_CAPACITY")
            Triple(day, index, fresh)
        }
        for ((day, index, fresh) in plan.filter { it.third.isNotEmpty() }) {
            val bytes = fresh.map { encode(it, now.toEpochMilli()) }.reduce(ByteArray::plus)
            appendBytes(dayFile(vehicleDirectory, day), bytes)
            index.size += bytes.size
            index.keys += fresh.map { it.key() }
        }
        val stored = plan.flatMap { it.third }
        if (stored.isNotEmpty()) remember(batch.vehicleId, stored, now)
        return Receipt(stored.size, batch.readings.size - stored.size, stored)
    }

    private fun remember(vehicleId: String, stored: List<Reading>, now: Instant) {
        stored.groupBy { it.sensorId }.forEach { (sensorId, readings) ->
            val top = readings.maxBy { it.measuredAt }
            newest.merge(vehicleId to sensorId, top.toLatest(vehicleId, now)) { old, added ->
                if (added.measuredAt >= old.measuredAt) added else old.copy(receivedAt = now)
            }
        }
    }

    private fun prepare(vehicleId: String) {
        check(directory.isAbsolute && directory.normalize() == directory)
        Files.createDirectories(directory.resolve(vehicleId))
        checkNoLinks(directory.resolve(vehicleId))
    }

    /** Re-reads a day file whose size is not what this process wrote (another process appended, or a write broke). */
    private fun index(vehicleId: String, day: String): DayIndex {
        val file = dayFile(directory.resolve(vehicleId), day)
        val size = if (Files.exists(file, NOFOLLOW_LINKS)) Files.size(file) else 0L
        indexes[vehicleId to day]?.takeIf { it.size == size }?.let { return it }
        val whole = if (size > 0) Files.readAllBytes(file) else ByteArray(0)
        val complete = completeLines(whole)
        if (complete.size != whole.size) {
            FileChannel.open(file, StandardOpenOption.WRITE).use { it.truncate(complete.size.toLong()) }
        }
        return DayIndex(complete.size.toLong(), decode(complete).mapTo(HashSet()) { it.key() })
            .also { indexes[vehicleId to day] = it }
    }

    /** The newest measurement of every sensor that has ever reported. */
    fun latest(): List<Latest> = newest.values.sortedWith(compareBy({ it.vehicleId }, { it.sensorId }))

    fun stale(latest: Latest): Boolean = clock().isAfter(latest.receivedAt.plus(staleAfter))

    fun now(): Instant = clock()

    /** All stored measurements of one vehicle in [from]..[to], oldest first. Readers take no lock. */
    fun readings(vehicleId: String, from: Instant, to: Instant): List<Reading> {
        val vehicleDirectory = directory.resolve(vehicleId)
        val last = LocalDate.ofInstant(to, SEOUL)
        val days = generateSequence(LocalDate.ofInstant(from, SEOUL)) { it.plusDays(1) }
            .takeWhile { !it.isAfter(last) }
        return days.map { dayFile(vehicleDirectory, it.toString()) }
            .filter { Files.isRegularFile(it, NOFOLLOW_LINKS) }
            .flatMap { decode(Files.readAllBytes(it)) }
            .filter { !it.measuredAt.isBefore(from) && !it.measuredAt.isAfter(to) }
            .sortedWith(compareBy({ it.measuredAt }, { it.sensorId })).toList()
    }

    /** After a restart the newest value of each sensor comes from the last file of its vehicle. */
    private fun seed() {
        for (vehicleDirectory in vehicleDirectories(directory)) {
            val vehicleId = vehicleDirectory.fileName.toString()
            val last = dayFiles(vehicleDirectory).lastOrNull() ?: continue
            decode(Files.readAllBytes(last)).groupBy { it.sensorId }.forEach { (sensorId, readings) ->
                val top = readings.maxBy { it.measuredAt }
                val received = Instant.ofEpochMilli(readings.maxOf { it.receivedAtMillis })
                newest[vehicleId to sensorId] = top.toLatest(vehicleId, received)
            }
        }
    }
}
