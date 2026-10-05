package com.evnsolution.meatbox.auth

fun interface SessionVerifier {
    fun verify(cookie: String?): String
}

class LoginRequiredException : RuntimeException()

class SessionUnavailableException(
    val errorCode: String,
    cause: Throwable? = null,
) : RuntimeException(cause)
