package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.time.Duration

/** Atomic rename protects readers; this OS lock also protects writers in overlapping service processes. */
internal class DriverFileLock(private val path: Path, private val busyCode: String = "DRIVER_STATE_BUSY") {
    fun <T> withLock(action: () -> T): T {
        val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
        val options = setOf(StandardOpenOption.CREATE, StandardOpenOption.WRITE, NOFOLLOW_LINKS)
        return FileChannel.open(path, options, permissions).use { channel ->
            acquire(channel).use { action() }
        }
    }

    private fun acquire(channel: FileChannel): FileLock {
        val deadline = System.nanoTime() + Duration.ofSeconds(1).toNanos()
        var acquired: FileLock? = null
        while (acquired == null) {
            acquired = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
            if (acquired == null && System.nanoTime() >= deadline) {
                driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), busyCode)
            }
            if (acquired == null) Thread.sleep(RETRY_MILLIS)
        }
        return acquired
    }

    companion object { private const val RETRY_MILLIS = 10L }
}
