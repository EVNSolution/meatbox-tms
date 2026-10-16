package com.evnsolution.meatbox.legacy

import org.springframework.boot.context.properties.ConfigurationProperties
import java.net.URI
import java.nio.file.Path

@ConfigurationProperties("meatbox.compat")
data class LegacyProperties(
    val enabled: Boolean = false,
    val legacyApiOrigin: String = "",
    val dispatchDataDir: String = "",
) {
    fun settings(): LegacySettings {
        require(enabled) { "Compatibility mode must be enabled" }
        val origin = validateLoopbackOrigin(legacyApiOrigin)
        val directory = Path.of(dispatchDataDir)
        require(dispatchDataDir.isNotBlank() && directory.isAbsolute) {
            "meatbox.compat.dispatch-data-dir must be an explicit absolute path"
        }
        return LegacySettings(origin, directory.normalize())
    }

    private fun validateLoopbackOrigin(value: String): URI {
        require(value.isNotBlank()) { "meatbox.compat.legacy-api-origin is required" }
        val uri = runCatching { URI(value) }.getOrElse {
            throw IllegalArgumentException("meatbox.compat.legacy-api-origin must be a valid URI", it)
        }
        require(uri.scheme == "http" && uri.host in LOOPBACK_HOSTS) {
            "meatbox.compat.legacy-api-origin must be an HTTP loopback origin"
        }
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "meatbox.compat.legacy-api-origin must not contain credentials, query, or fragment"
        }
        require(uri.rawPath.isNullOrEmpty()) {
            "meatbox.compat.legacy-api-origin must not contain a path"
        }
        require(uri.port == -1 || uri.port in MIN_PORT..MAX_PORT) {
            "meatbox.compat.legacy-api-origin has an invalid port"
        }
        val canonicalPort = if (uri.port == DEFAULT_HTTP_PORT) -1 else uri.port
        val canonical = URI(uri.scheme, null, uri.host, canonicalPort, null, null, null)
        require(canonical.toString() == value) {
            "meatbox.compat.legacy-api-origin must be an exact loopback HTTP origin"
        }
        return canonical
    }

    companion object {
        private const val MIN_PORT = 1
        private const val MAX_PORT = 65_535
        private const val DEFAULT_HTTP_PORT = 80
        private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "[::1]")
    }
}

data class LegacySettings(
    val legacyApiOrigin: URI,
    val dispatchDataDirectory: Path,
)
