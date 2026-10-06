package com.evnsolution.meatbox.resources

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatIllegalArgumentException
import org.junit.jupiter.api.Test
import java.nio.file.Path

class ResourcePropertiesTest {
    @Test
    fun `accepts an exact HTTPS origin and normalized absolute database path`() {
        val database = Path.of(System.getProperty("java.io.tmpdir"), "resources.sqlite").normalize().toAbsolutePath()

        val settings = ResourceProperties(true, database.toString(), "https://tms.example.com").settings(true)

        assertThat(settings.database).isEqualTo(database)
        assertThat(settings.publicOrigin.toString()).isEqualTo("https://tms.example.com")
    }

    @Test
    fun `accepts only exact HTTP loopback origins`() {
        val database = Path.of(System.getProperty("java.io.tmpdir"), "resources.sqlite").normalize().toAbsolutePath()
        for (origin in listOf("http://127.0.0.1:4173", "http://localhost", "http://[::1]:8080")) {
            assertThat(ResourceProperties(true, database.toString(), origin).settings(true).publicOrigin.toString())
                .isEqualTo(origin)
        }
        for (origin in listOf(
            "http://example.com",
            "https://example.com/",
            "https://user@example.com",
            "https://example.com:443",
            "HTTP://localhost",
        )) {
            assertThatIllegalArgumentException().isThrownBy {
                ResourceProperties(true, database.toString(), origin).settings(true)
            }
        }
    }

    @Test
    fun `requires compatibility authentication and an explicit safe path`() {
        val database = Path.of(System.getProperty("java.io.tmpdir"), "resources.sqlite").normalize().toAbsolutePath()

        assertThatIllegalArgumentException().isThrownBy {
            ResourceProperties(true, database.toString(), "https://tms.example.com").settings(false)
        }
        assertThatIllegalArgumentException().isThrownBy {
            ResourceProperties(true, "relative.sqlite", "https://tms.example.com").settings(true)
        }
        assertThatIllegalArgumentException().isThrownBy {
            val unsafe = database.resolveSibling("folder/../resources.sqlite").toString()
            ResourceProperties(true, unsafe, "https://tms.example.com").settings(true)
        }
    }
}
