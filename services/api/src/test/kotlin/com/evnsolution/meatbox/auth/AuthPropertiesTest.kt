package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatIllegalArgumentException
import org.junit.jupiter.api.Test
import java.nio.file.Path

class AuthPropertiesTest {
    @Test
    fun `accepts an exact origin and normalized absolute account path`() {
        val access = Path.of(System.getProperty("java.io.tmpdir"), "access.json").normalize().toAbsolutePath()

        val settings = AuthProperties(true, access.toString(), "https://tms.example.com").settings()

        assertThat(settings.accessFile).isEqualTo(access)
        assertThat(settings.publicOrigin.toString()).isEqualTo("https://tms.example.com")
    }

    @Test
    fun `rejects relative paths and non exact or public HTTP origins`() {
        val access = Path.of(System.getProperty("java.io.tmpdir"), "access.json").normalize().toAbsolutePath()
        for (origin in listOf("http://example.com", "https://example.com/", "https://example.com:443")) {
            assertThatIllegalArgumentException().isThrownBy {
                AuthProperties(true, access.toString(), origin).settings()
            }
        }
        assertThatIllegalArgumentException().isThrownBy {
            AuthProperties(true, "access.json", "http://127.0.0.1:4173").settings()
        }
    }
}
