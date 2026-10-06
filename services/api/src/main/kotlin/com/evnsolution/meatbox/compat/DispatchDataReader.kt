package com.evnsolution.meatbox.compat

import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.nio.file.Files
import java.io.IOException
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.nio.channels.Channels
import java.io.InputStream
import java.security.MessageDigest
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.HexFormat
import java.util.zip.GZIPOutputStream

@Suppress("TooManyFunctions")
class DispatchDataReader(
    settings: CompatSettings,
) {
    internal val files = SafeSourceFiles(settings.dispatchDataDirectory)
    private val mapper = JsonMapper.builder().build()

    fun manifest(acceptEncoding: String?): DispatchFile {
        val loaded = loadManifest()
        return selectFile(Path.of("manifest.json"), acceptEncoding, loaded.raw)
    }

    fun day(date: String, acceptEncoding: String?): DispatchFile {
        if (!isValidDate(date)) throw notFound()
        val manifest = loadManifest()
        if (date !in manifest.dates) throw notFound()
        return selectFile(Path.of("days", "$date.json"), acceptEncoding)
    }

    fun regions(acceptEncoding: String?): DispatchFile {
        loadManifest()
        return selectFile(Path.of("regions.geojson"), acceptEncoding)
    }

    internal fun generatedJson(bytes: ByteArray, acceptEncoding: String?): DispatchFile {
        val useGzip = acceptsGzip(acceptEncoding)
        val selected = if (useGzip) gzip(bytes) else bytes
        return DispatchFile(
            bytes = selected,
            etag = etag(selected),
            contentEncoding = if (useGzip) "gzip" else null,
            varyAcceptEncoding = true,
        )
    }

    internal fun loadManifest(): Manifest {
        val raw = files.readRequired(Path.of("manifest.json"), missingManifest = true)
        val node = runCatching { mapper.readTree(raw) }.getOrElse { throw invalid(it) }
        requireManifest(node.isObject && node.get("schemaVersion")?.takeIf(JsonNode::isInt)?.asInt() == 1)
        val defaultDate = node.get("defaultDate")?.takeIf(JsonNode::isString)?.asString()
        val dateNodes = node.get("dates")?.takeIf(JsonNode::isArray)
        requireManifest(defaultDate != null && dateNodes != null && !dateNodes.isEmpty && isValidDate(defaultDate))
        val dateValues = dateNodes!!.iterator().asSequence().map { item ->
            item.takeIf(JsonNode::isObject)?.get("date")?.takeIf(JsonNode::isString)?.asString()
        }.toList()
        requireManifest(dateValues.all { it != null && isValidDate(it) })
        val dates = dateValues.filterNotNull().toSet()
        requireManifest(dates.size == dateValues.size && defaultDate!! in dates)
        return Manifest(raw, node, defaultDate!!, dates)
    }

    private fun selectFile(relative: Path, acceptEncoding: String?, knownRaw: ByteArray? = null): DispatchFile {
        requireBaseFile(files.status(relative))
        val gzipRelative = Path.of("$relative.gz")
        val hasGzip = optionalGzip(files.status(gzipRelative))
        val useGzip = hasGzip && acceptsGzip(acceptEncoding)
        val selected = if (useGzip) gzipRelative else relative
        val bytes = if (!useGzip && knownRaw != null) {
            knownRaw
        } else {
            files.readRequired(selected, missingManifest = false)
        }
        return DispatchFile(
            bytes = bytes,
            etag = etag(bytes),
            contentEncoding = if (useGzip) "gzip" else null,
            varyAcceptEncoding = hasGzip,
        )
    }

    private fun acceptsGzip(value: String?): Boolean {
        val choices = value.orEmpty().split(',').map { token ->
            val parts = token.trim().split(';').map(String::trim)
            val quality = parts.drop(1).firstOrNull { it.startsWith("q=", ignoreCase = true) }
                ?.substringAfter('=')?.toDoubleOrNull() ?: 1.0
            parts.firstOrNull().orEmpty() to quality
        }
        val choice = choices.firstOrNull { it.first.equals("gzip", true) }
            ?: choices.firstOrNull { it.first == "*" }
        return choice != null && choice.second > 0.0
    }

    private fun isValidDate(value: String): Boolean = value.matches(DATE_PATTERN) && runCatching {
        LocalDate.parse(value, DATE_FORMAT)
    }.isSuccess

    private fun etag(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return "\"${HexFormat.of().formatHex(digest)}\""
    }

    private fun gzip(bytes: ByteArray): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        GZIPOutputStream(output).use { it.write(bytes) }
        return output.toByteArray()
    }

    private fun requireManifest(condition: Boolean) {
        if (!condition) throw invalid()
    }

    private fun requireBaseFile(status: FileStatus) {
        when (status) {
            FileStatus.FILE -> Unit
            FileStatus.MISSING -> throw notFound()
            FileStatus.INVALID -> throw invalid()
        }
    }

    private fun optionalGzip(status: FileStatus): Boolean = when (status) {
        FileStatus.FILE -> true
        FileStatus.MISSING -> false
        FileStatus.INVALID -> throw invalid()
    }

    companion object {
        private val DATE_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val DATE_FORMAT = DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)
    }
}

internal data class Manifest(
    val raw: ByteArray,
    val node: JsonNode,
    val defaultDate: String,
    val dates: Set<String>,
)

internal class SafeSourceFiles(private val root: Path) {
    fun readRequired(relative: Path, missingManifest: Boolean): ByteArray {
        return when (status(relative)) {
            FileStatus.MISSING -> missingData(missingManifest)
            FileStatus.INVALID -> invalidData()
            FileStatus.FILE -> readFile(relative, missingManifest)
        }
    }

    private fun readFile(relative: Path, missingManifest: Boolean): ByteArray {
        val candidate = resolve(relative)
        return try {
            Files.newByteChannel(candidate, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = java.nio.ByteBuffer.allocate(DEFAULT_BUFFER_SIZE)
                while (channel.read(buffer) >= 0) {
                    buffer.flip()
                    val bytes = ByteArray(buffer.remaining())
                    buffer.get(bytes)
                    output.write(bytes)
                    buffer.clear()
                }
                output.toByteArray()
            }
        } catch (_: NoSuchFileException) {
            missingData(missingManifest)
        } catch (error: IOException) {
            throw invalid(error)
        }
    }

    fun status(relative: Path): FileStatus = when {
        relative.isAbsolute || relative.normalize().startsWith("..") -> FileStatus.INVALID
        !Files.exists(root, LinkOption.NOFOLLOW_LINKS) -> FileStatus.MISSING
        Files.isSymbolicLink(root) || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) -> FileStatus.INVALID
        hasSymbolicLink(relative) -> FileStatus.INVALID
        !Files.exists(resolve(relative), LinkOption.NOFOLLOW_LINKS) -> FileStatus.MISSING
        Files.isRegularFile(resolve(relative), LinkOption.NOFOLLOW_LINKS) -> FileStatus.FILE
        else -> FileStatus.INVALID
    }

    @Suppress("ThrowsCount")
    fun stampRequired(relative: Path): FileStamp {
        when (status(relative)) {
            FileStatus.MISSING -> throw notFound()
            FileStatus.INVALID -> throw invalid()
            FileStatus.FILE -> Unit
        }
        return try {
            val attributes = Files.readAttributes(
                resolve(relative),
                BasicFileAttributes::class.java,
                LinkOption.NOFOLLOW_LINKS,
            )
            FileStamp(attributes.lastModifiedTime(), attributes.size())
        } catch (_: NoSuchFileException) {
            throw notFound()
        } catch (error: IOException) {
            throw invalid(error)
        }
    }

    fun <T> useRequired(relative: Path, missingManifest: Boolean, block: (InputStream) -> T): T {
        when (status(relative)) {
            FileStatus.MISSING -> missingData(missingManifest)
            FileStatus.INVALID -> invalidData()
            FileStatus.FILE -> Unit
        }
        return try {
            Files.newByteChannel(resolve(relative), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
                Channels.newInputStream(channel).use(block)
            }
        } catch (_: NoSuchFileException) {
            missingData(missingManifest)
        } catch (error: IOException) {
            throw invalid(error)
        }
    }

    private fun hasSymbolicLink(relative: Path): Boolean {
        var current = root
        return relative.any { part ->
            current = current.resolve(part)
            Files.isSymbolicLink(current)
        }
    }

    private fun resolve(relative: Path): Path {
        val candidate = root.resolve(relative).normalize()
        if (!candidate.startsWith(root)) throw invalid()
        return candidate
    }

}

internal enum class FileStatus { FILE, MISSING, INVALID }

internal data class FileStamp(val modified: FileTime, val size: Long)

private fun missingData(manifest: Boolean): Nothing = if (manifest) throw unavailable() else throw notFound()

private fun invalidData(): Nothing = throw invalid()

data class DispatchFile(
    val bytes: ByteArray,
    val etag: String,
    val contentEncoding: String?,
    val varyAcceptEncoding: Boolean,
)

class DispatchDataException(
    val status: HttpStatus,
    val code: String,
    cause: Throwable? = null,
) : RuntimeException(cause)

private fun unavailable() = DispatchDataException(HttpStatus.NOT_FOUND, "DISPATCH_DATA_UNAVAILABLE")

private fun notFound() = DispatchDataException(HttpStatus.NOT_FOUND, "DISPATCH_DATA_NOT_FOUND")

internal fun queryInvalid() = DispatchDataException(HttpStatus.BAD_REQUEST, "DISPATCH_DATA_QUERY_INVALID")

private fun invalid(cause: Throwable? = null) =
    DispatchDataException(HttpStatus.INTERNAL_SERVER_ERROR, "DISPATCH_DATA_INVALID", cause)
