package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

private val PHOTO_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
private val DATE_NAME = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

internal fun validPhotoId(value: String): Boolean = PHOTO_ID.matches(value)

internal class StoredPhoto(val bytes: ByteArray, val contentType: String)

/** Photos live at `<state>/photos/<date>/<photoId>.<ext>`. Only server-made UUIDs reach the file system. */
internal class DriverPhotos(private val root: Path) {
    fun save(date: String, bytes: ByteArray): Pair<String, Int> {
        val type = TYPES.firstOrNull { bytes.startsWith(it.magic) }
            ?: driverFail(HttpStatus.UNSUPPORTED_MEDIA_TYPE.value(), "UNSUPPORTED_PHOTO_TYPE")
        val directory = directory(date)
        try {
            Files.createDirectories(directory, attribute("rwx------"))
            check(!Files.isSymbolicLink(directory) && Files.isDirectory(directory, NOFOLLOW_LINKS))
            Files.newDirectoryStream(directory).use { entries ->
                if (entries.count() >= MAX_PER_DATE) driverFail(HttpStatus.CONFLICT.value(), "PHOTO_CAPACITY")
            }
            val id = UUID.randomUUID().toString()
            val temporary = directory.resolve(".$id.tmp")
            try {
                val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
                FileChannel.open(temporary, options, attribute("rw-------")).use {
                    val buffer = ByteBuffer.wrap(bytes)
                    while (buffer.hasRemaining()) it.write(buffer)
                    it.force(true)
                }
                Files.move(temporary, directory.resolve("$id.${type.extension}"), StandardCopyOption.ATOMIC_MOVE)
            } finally {
                runCatching { Files.deleteIfExists(temporary) }
            }
            return id to bytes.size
        } catch (_: IOException) {
            driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), "DRIVER_PHOTO_WRITE_FAILED")
        }
    }

    fun exists(date: String, photoId: String): Boolean = find(date, photoId) != null

    fun read(date: String, photoId: String): StoredPhoto {
        val (path, type) = find(date, photoId) ?: driverFail(HttpStatus.NOT_FOUND.value(), "PHOTO_NOT_FOUND")
        return try {
            StoredPhoto(Files.readAllBytes(path), type.contentType)
        } catch (_: IOException) {
            driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), "DRIVER_PHOTO_READ_FAILED")
        }
    }

    private fun find(date: String, photoId: String): Pair<Path, PhotoType>? {
        if (!validPhotoId(photoId)) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_PHOTO_ID")
        val directory = directory(date)
        return TYPES.firstNotNullOfOrNull { type ->
            val path = directory.resolve("$photoId.${type.extension}")
            (path to type).takeIf { Files.isRegularFile(path, NOFOLLOW_LINKS) }
        }
    }

    private fun directory(date: String): Path {
        if (!DATE_NAME.matches(date)) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_DATE")
        return root.resolve("photos").resolve(date)
    }

    private class PhotoType(val extension: String, val contentType: String, val magic: ByteArray)

    private fun ByteArray.startsWith(prefix: ByteArray) =
        size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }

    private fun attribute(mode: String) = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(mode))

    companion object {
        private const val MAX_PER_DATE = 5000
        private val TYPES = listOf(
            PhotoType("jpg", "image/jpeg", byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())),
            PhotoType("png", "image/png", byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)),
        )
    }
}
