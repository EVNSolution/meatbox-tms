package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class AuthServiceTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `logs in with a Node account stores only a token hash and revokes a disabled user`() {
        val file = accountFile()
        val service = AuthService(AuthSettings(file, URI("http://127.0.0.1:4173")))

        val login = service.login(LoginInput("TeStEr", "correct horse battery staple"))

        assertThat(login.user.username).isEqualTo("tester")
        assertThat(service.session(login.token)?.displayName).isEqualTo("검토자")
        assertThat(Files.readString(file)).doesNotContain(login.token)
        Files.writeString(file, Files.readString(file).replace("\"disabled\":false", "\"disabled\":true"))
        assertThat(service.session(login.token)).isNull()
        assertThatThrownBy { service.verify("${AuthService.COOKIE_NAME}=${login.token}") }
            .isInstanceOf(LoginRequiredException::class.java)
    }

    @Test
    fun `uses dummy password work and one generic error for unknown wrong and disabled accounts`() {
        val file = accountFile()
        val service = AuthService(AuthSettings(file, URI("http://127.0.0.1:4173")))

        for (input in listOf(
            LoginInput("unknown", "correct horse battery staple"),
            LoginInput("tester", "wrong password"),
        )) {
            assertThatThrownBy { service.login(input) }
                .isInstanceOf(AccessException::class.java)
                .hasMessage("Unable to sign in.")
        }
    }

    @Test
    fun `requires exactly one named session cookie`() {
        assertThat(AuthService.tokenFrom("other=x; meatbox_session=token")).isEqualTo("token")
        assertThat(AuthService.tokenFrom("meatbox_session=one; meatbox_session=two")).isNull()
        assertThat(AuthService.tokenFrom(null)).isNull()
    }

    private fun accountFile(): Path = directory.resolve("access.json").also {
        Files.writeString(
            it,
            NodeScryptFixture.accountJson(),
        )
    }
}
