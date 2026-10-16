package com.evnsolution.meatbox.auth

fun interface SessionVerifier {
    fun verify(cookie: String?): String

    /** False for a verifier that knows no roles (the legacy Node session): every account is then an operator. */
    val knowsRoles: Boolean get() = false

    /** The user with the role. Only a verifier with [knowsRoles] answers anything but `ops`. */
    fun identify(cookie: String?): SessionIdentity = SessionIdentity(verify(cookie), Role.OPS)
}

class LoginRequiredException : RuntimeException()

class SessionUnavailableException(
    val errorCode: String,
    cause: Throwable? = null,
) : RuntimeException(cause)
