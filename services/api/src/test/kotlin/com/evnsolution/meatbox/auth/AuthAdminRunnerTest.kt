package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

class AuthAdminRunnerTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `issues an invitation to a new owner only file without printing the secret`() {
        val access = accountFile()
        val secretFile = directory.resolve("invite.txt")
        val properties = AuthProperties(
            accessFile = access.toString(),
            adminCommand = "issue-invite",
            adminOutput = secretFile.toString(),
            adminExpiresInMillis = 60_000,
        )
        val output = ByteArrayOutputStream()

        AuthAdminRunner(properties, "none").execute(PrintStream(output))

        val invite = Files.readString(secretFile).trim()
        assertThat(invite).hasSizeGreaterThanOrEqualTo(32)
        assertThat(output.toString()).contains(secretFile.toString()).doesNotContain(invite)
        assertThat(Files.getPosixFilePermissions(secretFile)).containsExactlyInAnyOrder(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
        )
        assertThat(Files.readString(access)).contains(AuthService.digest(invite)).doesNotContain(invite)
    }

    @Test
    fun `disables a user and invalidates its existing native session`() {
        val access = accountFile()
        val service = AuthService(AuthSettings(access, URI("http://127.0.0.1:4173")))
        val login = service.login(LoginInput("tester", "correct horse battery staple"))
        val properties = AuthProperties(
            accessFile = access.toString(),
            adminCommand = "disable-user",
            adminUsername = "TESTER",
        )

        AuthAdminRunner(properties, "none").execute(PrintStream(ByteArrayOutputStream()))

        assertThat(service.session(login.token)).isNull()
        assertThatThrownBy { service.login(LoginInput("tester", "correct horse battery staple")) }
            .isInstanceOfSatisfying(AccessException::class.java) { error ->
                assertThat(error.code).isEqualTo("USER_DISABLED")
            }
    }

    @Test
    fun `refuses administration while the web application type is active`() {
        val access = accountFile()
        val before = Files.readAllBytes(access)
        val properties = AuthProperties(
            accessFile = access.toString(),
            adminCommand = "disable-user",
            adminUsername = "tester",
        )

        assertThatThrownBy {
            AuthAdminRunner(properties, "servlet").execute(PrintStream(ByteArrayOutputStream()))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThat(Files.readAllBytes(access)).isEqualTo(before)
    }

    private fun accountFile(): Path = directory.resolve("access.json").also {
        Files.writeString(
            it,
            NodeScryptFixture.accountJson(),
        )
    }
}
