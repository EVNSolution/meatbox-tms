package com.evnsolution.meatbox.dispatch

import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

/** Replaces [target] with [bytes] through a synced 0600 temporary file in the same directory. Throws IOException. */
internal fun writeAtomically(target: Path, bytes: ByteArray) {
    val temporary = target.resolveSibling(".${target.fileName}.${UUID.randomUUID()}.tmp")
    try {
        val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
        val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        FileChannel.open(temporary, options, permissions).use {
            val buffer = ByteBuffer.wrap(bytes)
            while (buffer.hasRemaining()) it.write(buffer)
            it.force(true)
        }
        Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } finally {
        // A cleanup failure after atomic replacement must not report a failed write.
        runCatching { Files.deleteIfExists(temporary) }
    }
}
