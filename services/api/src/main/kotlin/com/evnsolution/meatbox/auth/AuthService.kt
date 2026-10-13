package com.evnsolution.meatbox.auth

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.HexFormat
import java.util.LinkedHashMap

class AuthService internal constructor(
    settings: AuthSettings,
    private val now: () -> Long = System::currentTimeMillis,
    private val hasher: PasswordHasher = PasswordHasher(),
    private val random: SecureRandom = SecureRandom(),
) : SessionVerifier {
    private val store = AuthStore(settings.accessFile)
    private val sessionFile = SessionFile(settings.sessionFile)
    private val sessions = LinkedHashMap<String, ActiveSession>(sessionFile.load(now()))
    private var lastPrune = now()

    fun register(input: RegisterInput): AuthUser {
        val username = validateUsername(input.username)
        val password = validatePassword(input.password)
        val displayName = validateDisplayName(input.displayName)
        if (input.invite.length !in INVITE_LENGTH) {
            throw AccessException("INVALID_INVITE", "Invitation is invalid or expired.", "invite")
        }
        val passwordHash = hasher.hash(password)
        return store.register(username, displayName, passwordHash, digest(input.invite), now())
    }

    fun login(input: LoginInput): LoginResult {
        val username = runCatching { validateUsername(input.username) }.getOrElse { "" }
        val passwordValid = input.password.length in PASSWORD_LENGTH
        val user = loadUser(username)
        val encoded = user?.passwordHash ?: PasswordHasher.DUMMY_HASH
        val validHash = verifyPassword(input.password, encoded)
        val credentialsValid = listOf(
            username.isNotEmpty(),
            passwordValid,
            user != null,
            validHash,
            user?.disabled == false,
        ).all { it }
        if (!credentialsValid) {
            throw AccessException(
                if (user?.disabled == true) "USER_DISABLED" else "BAD_CREDENTIALS",
                "Unable to sign in.",
            )
        }
        val token = randomToken()
        val expiresAt = now() + SESSION_TTL_MILLIS
        synchronized(sessions) {
            pruneSessions()
            if (sessions.size >= MAX_SESSIONS) sessions.remove(sessions.entries.first().key)
            sessions[digest(token)] = ActiveSession(username, expiresAt)
            sessionFile.save(sessions)
        }
        val authenticatedUser = requireNotNull(user)
        return LoginResult(token, authenticatedUser.toAuthUser(), expiresAt)
    }

    fun session(token: String?): AuthUser? {
        val activeEntry = activeSession(token) ?: return null
        val (key, active) = activeEntry
        val user = runCatching { store.user(active.username) }.getOrElse { throw sessionUnavailable(it) }
        val remainsValid = synchronized(sessions) {
            val current = sessions[key]
            listOf(
                current === active,
                current?.expiresAt?.let { it > now() } == true,
                user != null,
                user?.disabled == false,
            )
                .all { it }
        }
        if (!remainsValid) synchronized(sessions) {
            if (sessions.remove(key) != null) sessionFile.save(sessions)
        }
        return if (remainsValid) requireNotNull(user).toAuthUser() else null
    }

    fun logout(token: String?) {
        if (token != null) synchronized(sessions) {
            if (sessions.remove(digest(token)) != null) sessionFile.save(sessions)
        }
    }

    override fun verify(cookie: String?): String =
        session(tokenFrom(cookie))?.username ?: throw LoginRequiredException()

    private fun pruneSessions() {
        val current = now()
        if (current - lastPrune < SESSION_PRUNE_INTERVAL_MILLIS && sessions.size < MAX_SESSIONS) return
        if (sessions.entries.removeIf { it.value.expiresAt <= current }) sessionFile.save(sessions)
        lastPrune = current
    }

    private fun activeSession(token: String?): Pair<String, ActiveSession>? {
        if (token == null || token.length < MIN_TOKEN_LENGTH) return null
        val key = digest(token)
        val active = synchronized(sessions) {
            pruneSessions()
            sessions[key]?.takeIf { it.expiresAt > now() }
        }
        return active?.let { key to it }
    }

    private fun loadUser(username: String): StoredUser? = runCatching {
        if (username.isEmpty()) null else store.user(username)
    }.getOrElse { throw sessionUnavailable(it) }

    private fun verifyPassword(password: String, encoded: String): Boolean = runCatching {
        hasher.verify(password, encoded)
    }.getOrElse { error ->
        if (error is AuthUnavailableException) throw error
        false
    }

    private fun StoredUser.toAuthUser(): AuthUser = AuthUser(username, displayName, createdAt)

    private fun randomToken(): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(TOKEN_BYTES).also(random::nextBytes))

    companion object {
        const val COOKIE_NAME = "meatbox_session"
        const val SESSION_TTL_MILLIS = 8 * 60 * 60 * 1_000L
        private const val SESSION_PRUNE_INTERVAL_MILLIS = 5 * 60 * 1_000L
        private const val MAX_SESSIONS = 10_000
        private const val TOKEN_BYTES = 32
        private const val MIN_TOKEN_LENGTH = 32
        private val USERNAME_PATTERN = Regex("^[A-Za-z0-9](?:[A-Za-z0-9_.-]){2,39}$")
        private val PASSWORD_LENGTH = 8..128
        private val INVITE_LENGTH = 16..256

        fun tokenFrom(cookie: String?): String? {
            if (cookie.isNullOrEmpty()) return null
            val matches = cookie.split(';').map(String::trim).filter { it.startsWith("$COOKIE_NAME=") }
            return matches.singleOrNull()?.substring(COOKIE_NAME.length + 1)
        }

        fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .let(HexFormat.of()::formatHex)

        fun validateUsername(value: String): String {
            val username = value.trim()
            if (!USERNAME_PATTERN.matches(username)) {
                throw AccessException(
                    "VALIDATION",
                    "Username must be 3-40 ASCII letters, numbers, dots, underscores, or hyphens.",
                    "username",
                )
            }
            return username.lowercase()
        }

        fun validatePassword(value: String): String {
            if (value.length !in PASSWORD_LENGTH) {
                throw AccessException("VALIDATION", "Password must be 8-128 characters.", "password")
            }
            return value
        }

        fun validateDisplayName(value: String?): String? {
            if (value.isNullOrEmpty()) return null
            val trimmed = value.trim()
            val invalid = trimmed.isEmpty() || trimmed.length > DISPLAY_NAME_MAX_LENGTH ||
                CONTROL_CHARACTER.containsMatchIn(value)
            if (invalid) {
                throw AccessException(
                    "VALIDATION",
                    "Display name must be 1-80 printable characters.",
                    "displayName",
                )
            }
            return trimmed
        }

        private val CONTROL_CHARACTER = Regex("[\\u0000-\\u001f\\u007f]")
        private const val DISPLAY_NAME_MAX_LENGTH = 80
    }
}

data class LoginInput(val username: String, val password: String)

data class RegisterInput(
    val invite: String,
    val username: String,
    val displayName: String?,
    val password: String,
)

data class AuthUser(val username: String, val displayName: String, val createdAt: Long)

data class LoginResult(val token: String, val user: AuthUser, val expiresAt: Long)

internal data class ActiveSession(val username: String, val expiresAt: Long)

class AccessException(
    val code: String,
    override val message: String,
    val field: String? = null,
) : RuntimeException(message)

class AuthUnavailableException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

private fun sessionUnavailable(error: Throwable): SessionUnavailableException = when (error) {
    is SessionUnavailableException -> error
    else -> SessionUnavailableException("AUTH_UNAVAILABLE", error)
}
