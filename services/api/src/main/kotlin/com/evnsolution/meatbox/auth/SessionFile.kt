package com.evnsolution.meatbox.auth

import tools.jackson.databind.json.JsonMapper
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/**
 * Durable copy of the active session map, so an API restart or a blue/green switch keeps users signed in.
 * Entries hold only the SHA-256 digest of each token; expired entries are dropped on load and never revived.
 */
internal class SessionFile(private val file: Path) {
    private val mapper = JsonMapper.builder().build()

    fun load(now: Long): Map<String, ActiveSession> {
        val readable = Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
        val root = if (readable) runCatching { mapper.readTree(Files.readAllBytes(file)) }.getOrNull() else null
        val sessions = LinkedHashMap<String, ActiveSession>()
        if (root?.path("version")?.asInt(0) == VERSION) {
            root.path("sessions").properties().forEach { (key, value) ->
                val session = activeSession(value, now)
                if (session != null && DIGEST.matches(key)) sessions[key] = session
            }
        }
        return sessions
    }

    private fun activeSession(value: tools.jackson.databind.JsonNode, now: Long): ActiveSession? {
        val username = value.path("username").takeIf { it.isString }?.asString()
        val expiresAt = value.path("expiresAt").takeIf { it.isIntegralNumber }?.asLong()
        val current = expiresAt != null && expiresAt > now
        return if (username != null && current) ActiveSession(username, requireNotNull(expiresAt)) else null
    }

    fun save(sessions: Map<String, ActiveSession>) {
        val root = mapper.createObjectNode()
        root.put("version", VERSION)
        val node = root.putObject("sessions")
        sessions.forEach { (key, session) ->
            node.putObject(key).put("username", session.username).put("expiresAt", session.expiresAt)
        }
        val bytes = "${mapper.writeValueAsString(root)}\n".toByteArray(StandardCharsets.UTF_8)
        val temporary = file.resolveSibling(".${file.fileName}.${ProcessHandle.current().pid()}.tmp")
        try {
            Files.deleteIfExists(temporary)
            val attributes = PosixFilePermissions.asFileAttribute(OWNER_ONLY)
            FileChannel.open(temporary, setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE), attributes)
                .use { channel ->
                    val buffer = ByteBuffer.wrap(bytes)
                    while (buffer.hasRemaining()) channel.write(buffer)
                    channel.force(true)
                }
            Files.setPosixFilePermissions(temporary, OWNER_ONLY)
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (error: IOException) {
            runCatching { Files.deleteIfExists(temporary) }
            throw AuthUnavailableException("Cannot save session data", error)
        }
    }

    companion object {
        private const val VERSION = 1
        private val DIGEST = Regex("^[0-9a-f]{64}$")
        private val OWNER_ONLY = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
    }
}
