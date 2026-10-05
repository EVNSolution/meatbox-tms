package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

class AuthStoreTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `uses a hashed invite and persists the existing version one JSON shape`() {
        val file = directory.resolve("access.json")
        val invite = "valid-invitation-code"
        Files.writeString(
            file,
            """{"version":1,"users":{},"invites":{"${AuthService.digest(invite)}":{"createdAt":1,"expiresAt":9999}}}""",
        )

        val user = AuthStore(file).register("tester", "검토자", "encoded", AuthService.digest(invite), 100)

        assertThat(user).isEqualTo(AuthUser("tester", "검토자", 100))
        val saved = Files.readString(file)
        assertThat(saved).contains("\"version\" : 1", "\"usedBy\" : \"tester\"")
        assertThat(saved).doesNotContain(invite)
        assertThat(AuthStore(file).user("tester")?.passwordHash).isEqualTo("encoded")
        assertThat(Files.getPosixFilePermissions(file)).containsExactlyInAnyOrder(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
        )
    }

    @Test
    fun `fails closed for missing corrupt and symlink files without initializing data`() {
        val missing = directory.resolve("missing.json")
        assertUnavailable(missing)
        assertThat(missing).doesNotExist()

        val corrupt = directory.resolve("corrupt.json")
        Files.writeString(corrupt, "{")
        val before = Files.readAllBytes(corrupt)
        assertUnavailable(corrupt)
        assertThat(Files.readAllBytes(corrupt)).isEqualTo(before)

        val link = directory.resolve("linked.json")
        runCatching { Files.createSymbolicLink(link, corrupt.fileName) }.onSuccess { assertUnavailable(link) }

        val parentLink = directory.resolve("linked-parent")
        runCatching { Files.createSymbolicLink(parentLink, directory) }.onSuccess {
            assertUnavailable(parentLink.resolve("corrupt.json"))
        }
    }

    @Test
    fun `times out an existing cross process lock without changing the account file`() {
        val file = directory.resolve("access.json")
        Files.writeString(file, """{"version":1,"users":{},"invites":{}}""")
        val before = Files.readAllBytes(file)
        Files.createDirectory(Path.of("$file.lock"))

        assertThatThrownBy {
            AuthStore(file, lockTimeoutMillis = 20).register("tester", null, "encoded", "missing", 1)
        }.isInstanceOf(AuthUnavailableException::class.java)
        assertThat(Files.readAllBytes(file)).isEqualTo(before)
    }

    private fun assertUnavailable(path: Path) {
        assertThatThrownBy { AuthStore(path).user("tester") }
            .isInstanceOf(AuthUnavailableException::class.java)
    }
}
