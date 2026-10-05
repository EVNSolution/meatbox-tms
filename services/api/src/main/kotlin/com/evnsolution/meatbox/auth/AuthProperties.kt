package com.evnsolution.meatbox.auth

import org.springframework.boot.context.properties.ConfigurationProperties
import java.net.URI
import java.nio.file.Path

@ConfigurationProperties("meatbox.auth")
data class AuthProperties(
    val enabled: Boolean = false,
    val accessFile: String = "",
    val publicOrigin: String = "",
    val adminCommand: String = "",
    val adminOutput: String = "",
    val adminUsername: String = "",
    val adminExpiresInMillis: Long = DEFAULT_INVITE_TTL_MILLIS,
) {
    fun settings(): AuthSettings {
        require(enabled) { "Native authentication must be enabled" }
        return AuthSettings(accessPath(), validatePublicOrigin(publicOrigin))
    }

    fun accessPath(): Path = validateAccessFile(accessFile)

    private fun validateAccessFile(value: String): Path {
        require(value.isNotBlank()) { "meatbox.auth.access-file is required" }
        val path = runCatching { Path.of(value) }.getOrElse {
            throw IllegalArgumentException("meatbox.auth.access-file must be a valid path", it)
        }
        require(path.isAbsolute && path.normalize() == path) {
            "meatbox.auth.access-file must be an explicit normalized absolute path"
        }
        return path
    }

    private fun validatePublicOrigin(value: String): URI {
        require(value.isNotBlank()) { "meatbox.auth.public-origin is required" }
        val uri = runCatching { URI(value) }.getOrElse {
            throw IllegalArgumentException("meatbox.auth.public-origin must be a valid URI", it)
        }
        require(uri.host != null && (uri.scheme == "https" || uri.scheme == "http" && uri.host in LOOPBACK_HOSTS)) {
            "meatbox.auth.public-origin must be HTTPS or an HTTP loopback origin"
        }
        val containsOnlyOrigin = uri.rawUserInfo == null && uri.rawQuery == null &&
            uri.rawFragment == null && uri.rawPath.isNullOrEmpty()
        require(containsOnlyOrigin) {
            "meatbox.auth.public-origin must not contain credentials, path, query, or fragment"
        }
        require(uri.port == -1 || uri.port in MIN_PORT..MAX_PORT) {
            "meatbox.auth.public-origin has an invalid port"
        }
        val defaultPort = if (uri.scheme == "https") HTTPS_PORT else HTTP_PORT
        val canonicalPort = if (uri.port == defaultPort) -1 else uri.port
        val canonical = URI(uri.scheme, null, uri.host, canonicalPort, null, null, null)
        require(canonical.toString() == value) { "meatbox.auth.public-origin must be an exact origin" }
        return canonical
    }

    companion object {
        private const val MIN_PORT = 1
        private const val MAX_PORT = 65_535
        private const val HTTP_PORT = 80
        private const val HTTPS_PORT = 443
        private const val DEFAULT_INVITE_TTL_MILLIS = 24 * 60 * 60 * 1_000L
        private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "[::1]")
    }
}

data class AuthSettings(
    val accessFile: Path,
    val publicOrigin: URI,
)
