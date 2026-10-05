package com.evnsolution.meatbox.auth

import tools.jackson.databind.node.ObjectNode
import tools.jackson.databind.json.JsonMapper
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom
import java.util.HexFormat
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class AtomicAccessFile(
    private val file: Path,
    private val mapper: JsonMapper,
    private val lockTimeoutMillis: Long,
) {
    private val mutationLock = ReentrantLock()
    private val random = SecureRandom()
    private val fileLock = AccessFileLock(Path.of("$file.lock"), lockTimeoutMillis)

    fun read(): ObjectNode = mutationLock.withLock { readUnlocked() }

    fun <T> mutate(action: (ObjectNode) -> T): T = mutationLock.withLock {
        fileLock.withLock {
            val root = readUnlocked()
            val result = action(root)
            save(root)
            result
        }
    }

    private fun readUnlocked(): ObjectNode {
        val directory = file.parent ?: unavailable()
        val safePath = Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) &&
            !Files.isSymbolicLink(file) && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
        if (!safePath) unavailable()
        val root = runCatching { mapper.readTree(readBytes()) }.getOrElse { unavailable(it) }
        validateRoot(root as? ObjectNode ?: unavailable())
        return root
    }

    private fun readBytes(): ByteArray = try {
        FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val size = channel.size()
            if (size <= 0 || size > MAX_STORE_BYTES) unavailable()
            val buffer = ByteBuffer.allocate(size.toInt())
            while (buffer.hasRemaining()) if (channel.read(buffer) < 0) unavailable()
            buffer.array()
        }
    } catch (error: IOException) {
        unavailable(error)
    } catch (error: SecurityException) {
        unavailable(error)
    }

    private fun validateRoot(root: ObjectNode) {
        if (root.get("version")?.takeIf { it.isIntegralNumber }?.asInt() != VERSION) unavailable()
        val users = root.get("users")
        val invites = root.get("invites")
        val validUsers = users?.isObject == true && users.size() <= MAX_USERS
        val validInvites = invites?.isObject == true && invites.size() <= MAX_INVITES
        if (!validUsers || !validInvites) unavailable()
    }

    private fun save(root: ObjectNode) {
        val directory = file.parent ?: unavailable()
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) unavailable()
        val temporaryName = ".${file.fileName}.${ProcessHandle.current().pid()}.${randomHex()}.tmp"
        val temporary = directory.resolve(temporaryName)
        val bytes = "${mapper.writerWithDefaultPrettyPrinter().writeValueAsString(root)}\n"
            .toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_STORE_BYTES) unavailable()
        try {
            createSecureFile(temporary, bytes)
            atomicMove(temporary)
            runCatching { FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) } }
        } catch (error: IOException) {
            throw AuthUnavailableException("Cannot save access data", error)
        } catch (error: SecurityException) {
            throw AuthUnavailableException("Cannot save access data", error)
        } finally {
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    private fun atomicMove(temporary: Path) {
        try {
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (error: AtomicMoveNotSupportedException) {
            throw AuthUnavailableException("Atomic access file replacement is unavailable", error)
        }
    }

    private fun createSecureFile(path: Path, bytes: ByteArray) {
        val attributes = PosixFilePermissions.asFileAttribute(OWNER_ONLY)
        FileChannel.open(
            path,
            setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
            attributes,
        ).use { channel ->
            val buffer = ByteBuffer.wrap(bytes)
            while (buffer.hasRemaining()) channel.write(buffer)
            channel.force(true)
        }
        Files.setPosixFilePermissions(path, OWNER_ONLY)
    }

    private fun randomHex(): String = HexFormat.of().formatHex(
        ByteArray(RANDOM_SUFFIX_BYTES).also(random::nextBytes),
    )

    private fun unavailable(cause: Throwable? = null): Nothing =
        throw AuthUnavailableException("Access data is unavailable", cause)

    companion object {
        private const val VERSION = 1
        private const val MAX_USERS = 10_000
        private const val MAX_INVITES = 20_000
        private const val MAX_STORE_BYTES = 2 * 1024 * 1024L
        private const val RANDOM_SUFFIX_BYTES = 6
        private val OWNER_ONLY = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
    }
}

private class AccessFileLock(
    private val lock: Path,
    private val timeoutMillis: Long,
) {
    fun <T> withLock(action: () -> T): T {
        acquire()
        return try {
            action()
        } finally {
            runCatching { Files.delete(lock) }
        }
    }

    private fun acquire() {
        val deadline = System.nanoTime() + timeoutMillis * NANOS_PER_MILLI
        var acquired = false
        while (!acquired) {
            acquired = tryCreate()
            if (!acquired && System.nanoTime() >= deadline) {
                throw AuthUnavailableException("Access data is locked; retry after the active operation finishes")
            }
            if (!acquired) Thread.sleep(LOCK_RETRY_MILLIS)
        }
    }

    private fun tryCreate(): Boolean = try {
        Files.createDirectory(lock)
        true
    } catch (_: java.nio.file.FileAlreadyExistsException) {
        false
    } catch (error: IOException) {
        throw AuthUnavailableException("Cannot lock access data", error)
    } catch (error: SecurityException) {
        throw AuthUnavailableException("Cannot lock access data", error)
    }

    companion object {
        private const val LOCK_RETRY_MILLIS = 25L
        private const val NANOS_PER_MILLI = 1_000_000L
    }
}
