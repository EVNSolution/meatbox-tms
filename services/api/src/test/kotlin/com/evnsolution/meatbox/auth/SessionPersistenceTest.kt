package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

class SessionPersistenceTest {
    @TempDir
    lateinit var directory: Path

    private var clock = 1_700_000_000_000L

    private fun service(): AuthService {
        val file = directory.resolve("access.json")
        if (!Files.exists(file)) Files.writeString(file, NodeScryptFixture.accountJson())
        return AuthService(AuthSettings(file, URI("http://127.0.0.1:4173")), now = { clock })
    }

    @Test
    fun `a login survives a restart while logout expiry and disabling do not revive it`() {
        val first = service()
        val kept = first.login(LoginInput("tester", "correct horse battery staple")).token
        val loggedOut = first.login(LoginInput("tester", "correct horse battery staple")).token
        first.logout(loggedOut)
        val sessionFile = directory.resolve("sessions.json")
        assertThat(Files.getPosixFilePermissions(sessionFile))
            .containsExactlyInAnyOrder(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
        assertThat(Files.readString(sessionFile)).doesNotContain(kept).doesNotContain(loggedOut)

        val restarted = service()
        assertThat(restarted.session(kept)?.username).isEqualTo("tester")
        assertThat(restarted.session(loggedOut)).isNull()

        clock += AuthService.SESSION_TTL_MILLIS + 1
        assertThat(service().session(kept)).isNull()
        clock -= AuthService.SESSION_TTL_MILLIS + 1
        val access = directory.resolve("access.json")
        Files.writeString(access, Files.readString(access).replace("\"disabled\":false", "\"disabled\":true"))
        assertThat(service().session(kept)).isNull()
    }

    @Test
    fun `an unreadable session file starts with no sessions`() {
        Files.writeString(directory.resolve("sessions.json"), "not json")
        val fresh = service()
        assertThat(fresh.session("x".repeat(43))).isNull()
        val token = fresh.login(LoginInput("tester", "correct horse battery staple")).token
        assertThat(service().session(token)?.username).isEqualTo("tester")
    }
}
