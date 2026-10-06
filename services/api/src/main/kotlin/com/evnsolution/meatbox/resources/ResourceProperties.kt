package com.evnsolution.meatbox.resources

import org.springframework.boot.context.properties.ConfigurationProperties
import java.net.URI
import java.nio.file.Path

@ConfigurationProperties("meatbox.resources")
data class ResourceProperties(
    val enabled: Boolean = false,
    val database: String = "",
    val publicOrigin: String = "",
) {
    fun settings(compatEnabled: Boolean): ResourceSettings {
        require(enabled) { "Resource API must be enabled" }
        require(compatEnabled) { "meatbox.resources.enabled requires meatbox.compat.enabled" }
        return ResourceSettings(validateDatabasePath(database), validatePublicOrigin(publicOrigin))
    }

    private fun validateDatabasePath(value: String): Path {
        require(value.isNotBlank()) { "meatbox.resources.database is required" }
        val path = runCatching { Path.of(value) }.getOrElse {
            throw IllegalArgumentException("meatbox.resources.database must be a valid path", it)
        }
        require(path.isAbsolute && path.normalize() == path) {
            "meatbox.resources.database must be an explicit normalized absolute path"
        }
        return path
    }

    private fun validatePublicOrigin(value: String): URI {
        require(value.isNotBlank()) { "meatbox.resources.public-origin is required" }
        val uri = runCatching { URI(value) }.getOrElse {
            throw IllegalArgumentException("meatbox.resources.public-origin must be a valid URI", it)
        }
        require(uri.host != null && (uri.scheme == "https" || uri.scheme == "http" && uri.host in LOOPBACK_HOSTS)) {
            "meatbox.resources.public-origin must be HTTPS or an HTTP loopback origin"
        }
        val containsOnlyOrigin = uri.rawUserInfo == null && uri.rawQuery == null &&
            uri.rawFragment == null && uri.rawPath.isNullOrEmpty()
        require(containsOnlyOrigin) {
            "meatbox.resources.public-origin must not contain credentials, path, query, or fragment"
        }
        require(uri.port == -1 || uri.port in MIN_PORT..MAX_PORT) {
            "meatbox.resources.public-origin has an invalid port"
        }
        val defaultPort = if (uri.scheme == "https") DEFAULT_HTTPS_PORT else DEFAULT_HTTP_PORT
        val canonicalPort = if (uri.port == defaultPort) -1 else uri.port
        val canonical = URI(uri.scheme, null, uri.host, canonicalPort, null, null, null)
        require(canonical.toString() == value) {
            "meatbox.resources.public-origin must be an exact origin"
        }
        return canonical
    }

    companion object {
        private const val MIN_PORT = 1
        private const val MAX_PORT = 65_535
        private const val DEFAULT_HTTP_PORT = 80
        private const val DEFAULT_HTTPS_PORT = 443
        private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "[::1]")
    }
}

data class ResourceSettings(
    val database: Path,
    val publicOrigin: URI,
)
