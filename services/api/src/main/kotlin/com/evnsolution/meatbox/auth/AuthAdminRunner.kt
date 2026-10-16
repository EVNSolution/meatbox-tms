package com.evnsolution.meatbox.auth

import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.io.PrintStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

@Component
class AuthAdminRunner(
    private val properties: AuthProperties,
    @param:Value("\${spring.main.web-application-type:}") private val webApplicationType: String,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        if (properties.adminCommand.isEmpty()) return
        execute(System.out)
    }

    internal fun execute(output: PrintStream) {
        require(webApplicationType.equals("none", ignoreCase = true)) {
            "Authentication administration requires --spring.main.web-application-type=none"
        }
        val store = AuthStore(properties.accessPath())
        when (properties.adminCommand) {
            "issue-invite" -> {
                val outputPath = exactAbsolutePath(properties.adminOutput, "meatbox.auth.admin-output")
                val role = requiredRole()
                val invite = store.issueInvite(properties.adminExpiresInMillis, System.currentTimeMillis(), role)
                writeSecret(outputPath, invite)
                output.println(outputPath)
            }
            "set-role" -> {
                val username = AuthService.validateUsername(properties.adminUsername)
                val role = requiredRole()
                store.setRole(username, role)
                output.println("Set $username to ${role.wire}")
            }
            "disable-user" -> {
                val username = AuthService.validateUsername(properties.adminUsername)
                store.disableUser(username, System.currentTimeMillis())
                output.println("Disabled $username")
            }
            else -> throw IllegalArgumentException("Unknown meatbox.auth.admin-command")
        }
    }

    /** No default: an invitation that omits the role must not quietly make an operator. */
    private fun requiredRole(): Role = Role.parse(properties.adminRole)
        ?: throw IllegalArgumentException("meatbox.auth.admin-role must be ops or driver")

    private fun exactAbsolutePath(value: String, property: String): Path {
        require(value.isNotBlank()) { "$property is required" }
        val path = Path.of(value)
        require(path.isAbsolute && path.normalize() == path) {
            "$property must be an explicit normalized absolute path"
        }
        return path
    }

    private fun writeSecret(path: Path, secret: String) {
        val directory = path.parent
            ?: throw IllegalArgumentException("meatbox.auth.admin-output needs a parent directory")
        require(Files.isDirectory(directory)) { "meatbox.auth.admin-output parent directory must exist" }
        val permissions = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
        val attribute = PosixFilePermissions.asFileAttribute(permissions)
        val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        FileChannel.open(path, options, attribute).use { channel ->
            val bytes = "$secret\n".toByteArray(StandardCharsets.UTF_8)
            val buffer = ByteBuffer.wrap(bytes)
            while (buffer.hasRemaining()) channel.write(buffer)
            channel.force(true)
        }
        runCatching { FileChannel.open(directory, StandardOpenOption.READ).use { it.force(true) } }
    }
}
