package com.evnsolution.meatbox.legacy

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.nio.file.Path

class LegacyPropertiesTest {
    @Test
    fun `accepts an explicit loopback origin and absolute data directory`() {
        val settings = LegacyProperties(
            enabled = true,
            legacyApiOrigin = "http://127.0.0.1:3001",
            dispatchDataDir = Path.of("/tmp/dispatch-data").toString(),
        ).settings()

        assertThat(settings.legacyApiOrigin.toString()).isEqualTo("http://127.0.0.1:3001")
        assertThat(settings.dispatchDataDirectory).isAbsolute()
    }

    @Test
    fun `rejects remote ambiguous and credentialed origins`() {
        listOf(
            "https://127.0.0.1:3001",
            "http://example.com:3001",
            "http://127.0.0.2:3001",
            "http://user@127.0.0.1:3001",
            "http://127.0.0.1:3001/",
            "http://127.0.0.1:3001/api",
            "http://127.0.0.1:3001?target=other",
            "http://127.0.0.1:0",
            "http://localhost:80",
        ).forEach { origin ->
            assertThatThrownBy {
                LegacyProperties(true, origin, "/tmp/dispatch-data").settings()
            }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `accepts the three exact loopback host forms`() {
        listOf("http://127.0.0.1:3001", "http://localhost:8081", "http://[::1]:8081").forEach { origin ->
            val settings = LegacyProperties(true, origin, "/tmp/dispatch-data").settings()
            assertThat(settings.legacyApiOrigin.toString()).isEqualTo(origin)
        }
    }

    @Test
    fun `rejects a relative data directory`() {
        assertThatThrownBy {
            LegacyProperties(true, "http://127.0.0.1:3001", "relative/data").settings()
        }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
