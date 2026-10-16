package com.evnsolution.meatbox.auth

import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.node.ObjectNode
import tools.jackson.databind.json.JsonMapper
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64

internal class AuthStore(
    private val file: Path,
    private val lockTimeoutMillis: Long = LOCK_TIMEOUT_MILLIS,
) {
    private val mapper = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()
    private val random = SecureRandom()
    private val accessFile = AtomicAccessFile(file, mapper, lockTimeoutMillis)

    fun user(username: String): StoredUser? {
        val users = accessFile.read().get("users") as ObjectNode
        return users.get(username)?.let { storedUser(it, username) }
    }

    fun register(
        username: String,
        displayName: String?,
        passwordHash: String,
        inviteHash: String,
        now: Long,
    ): AuthUser = accessFile.mutate { root ->
        val users = root.get("users") as ObjectNode
        val invites = root.get("invites") as ObjectNode
        val invitation = usableInvitation(invites.get(inviteHash), now)
        if (invitation == null) {
            throw AccessException("INVALID_INVITE", "Invitation is invalid or expired.", "invite")
        }
        if (users.get(username) != null) {
            throw AccessException("USERNAME_TAKEN", "Username is unavailable.", "username")
        }
        if (users.size() >= MAX_USERS) throw AuthUnavailableException("Access user capacity is exhausted")
        // An invitation from before roles existed carries none and stays an operator's, as every account was.
        val role = invitation.get("role")?.takeIf { it.isString }?.asString()?.let(Role::parse)
            ?: Role.OPS.takeIf { invitation.get("role") == null }
            ?: throw AccessException("INVALID_INVITE", "Invitation is invalid or expired.", "invite")

        val user = mapper.createObjectNode()
        user.put("username", username)
        if (displayName != null) user.put("displayName", displayName)
        user.put("passwordHash", passwordHash)
        user.put("createdAt", now)
        user.put("disabled", false)
        user.put("role", role.wire)
        users.replace(username, user)
        invitation.put("usedAt", now)
        invitation.put("usedBy", username)
        AuthUser(username, displayName ?: username, now, role.wire)
    }

    private fun jsonTruthy(node: tools.jackson.databind.JsonNode?): Boolean = when {
        node == null || node.isNull -> false
        node.isBoolean -> node.asBoolean()
        node.isNumber -> node.asDouble() != 0.0
        node.isString -> node.asString().isNotEmpty()
        else -> true
    }

    private fun usableInvitation(node: tools.jackson.databind.JsonNode?, now: Long): ObjectNode? {
        val invitation = node?.takeIf { it.isObject } as? ObjectNode
        val expiresAt = invitation?.get("expiresAt")?.takeIf { it.isNumber }?.asLong()
        val available = invitation != null && expiresAt != null
        val unused = !jsonTruthy(invitation?.get("usedAt"))
        val current = expiresAt?.let { it > now } == true
        val usable = available && unused && current
        return invitation.takeIf { usable }
    }

    fun issueInvite(expiresInMillis: Long, now: Long, role: Role): String {
        if (expiresInMillis !in 1..MAX_INVITE_TTL_MILLIS) {
            throw AccessException("VALIDATION", "Invitation lifetime must be between 1 millisecond and 30 days.")
        }
        val invite = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(INVITE_BYTES).also(random::nextBytes))
        accessFile.mutate { root ->
            val invites = root.get("invites") as ObjectNode
            if (invites.size() >= MAX_INVITES) throw AuthUnavailableException("Invitation capacity is exhausted")
            val invitation = mapper.createObjectNode()
            invitation.put("createdAt", now)
            invitation.put("expiresAt", Math.addExact(now, expiresInMillis))
            invitation.put("role", role.wire)
            invites.replace(AuthService.digest(invite), invitation)
            invite
        }
        return invite
    }

    fun disableUser(username: String, now: Long): AuthUser = accessFile.mutate { root ->
        val users = root.get("users") as ObjectNode
        val node = users.get(username) ?: throw AccessException("USER_NOT_FOUND", "User does not exist.")
        val user = storedUser(node, username)
        val mutable = node as ObjectNode
        mutable.put("disabled", true)
        mutable.put("disabledAt", now)
        AuthUser(user.username, user.displayName, user.createdAt, user.roleName)
    }

    /** Takes effect on the user's next request: sessions hold no role. */
    fun setRole(username: String, role: Role): AuthUser = accessFile.mutate { root ->
        val users = root.get("users") as ObjectNode
        val node = users.get(username) ?: throw AccessException("USER_NOT_FOUND", "User does not exist.")
        val user = storedUser(node, username)
        (node as ObjectNode).put("role", role.wire)
        AuthUser(user.username, user.displayName, user.createdAt, role.wire)
    }

    fun users(): List<StoredUser> {
        val users = accessFile.read().get("users") as ObjectNode
        return users.properties().map { (name, node) -> storedUser(node, name) }
    }

    private fun storedUser(node: tools.jackson.databind.JsonNode, expectedUsername: String): StoredUser {
        if (!node.isObject) unavailable()
        val username = node.get("username")?.takeIf { it.isString }?.asString() ?: unavailable()
        val normalized = runCatching { AuthService.validateUsername(username) }.getOrNull()
        if (username != expectedUsername || normalized != username) {
            unavailable()
        }
        val passwordHash = node.get("passwordHash")?.takeIf { it.isString }?.asString() ?: unavailable()
        val createdAt = node.get("createdAt")?.takeIf { it.isIntegralNumber }?.asLong() ?: unavailable()
        val displayName = node.get("displayName")?.takeIf { it.isString }?.asString() ?: username
        val disabled = node.get("disabled")?.takeIf { it.isBoolean }?.asBoolean() ?: false
        return StoredUser(username, displayName, passwordHash, createdAt, disabled, roleOf(node.get("role")))
    }

    // ponytail: a missing role means ops. It is how accounts that predate roles keep working; once none is left,
    // answer "no role" here instead (docs/security-and-access.md).
    private fun roleOf(node: tools.jackson.databind.JsonNode?): Role? =
        if (node == null || node.isNull) Role.OPS else Role.parse(node.takeIf { it.isString }?.asString())

    private fun unavailable(cause: Throwable? = null): Nothing =
        throw AuthUnavailableException("Access data is unavailable", cause)

    companion object {
        private const val MAX_USERS = 10_000
        private const val MAX_INVITES = 20_000
        private const val INVITE_BYTES = 32
        private const val MAX_INVITE_TTL_MILLIS = 30 * 24 * 60 * 60 * 1_000L
        private const val LOCK_TIMEOUT_MILLIS = 5_000L
    }
}

internal data class StoredUser(
    val username: String,
    val displayName: String,
    val passwordHash: String,
    val createdAt: Long,
    val disabled: Boolean,
    val role: Role?,
) {
    val roleName: String? get() = role?.wire
}
