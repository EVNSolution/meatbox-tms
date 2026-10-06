package com.evnsolution.meatbox.auth

import org.bouncycastle.crypto.generators.SCrypt
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Semaphore

internal class PasswordHasher(
    private val random: SecureRandom = SecureRandom(),
    concurrency: Int = PASSWORD_CONCURRENCY,
) {
    private val permits = Semaphore(concurrency)

    fun hash(password: String): String = withPermit {
        val salt = ByteArray(SALT_BYTES).also(random::nextBytes).base64Url()
        val hash = derive(password, salt, N, R, P, KEY_BYTES)
        "scrypt\$$N\$$R\$$P\$$salt\$${hash.base64Url()}"
    }

    fun verify(password: String, encoded: String): Boolean = withPermit {
        val pieces = encoded.split('$')
        if (pieces.size != ENCODED_PARTS || pieces[0] != "scrypt") return@withPermit false
        val n = pieces[1].toIntOrNull() ?: return@withPermit false
        val r = pieces[2].toIntOrNull() ?: return@withPermit false
        val p = pieces[3].toIntOrNull() ?: return@withPermit false
        val expected = runCatching { DECODER.decode(pieces[5]) }.getOrNull() ?: return@withPermit false
        val salt = pieces[SALT_PART]
        if (!validParameters(n, r, p, expected.size) || salt.length !in SALT_LENGTH) return@withPermit false
        val actual = runCatching { derive(password, salt, n, r, p, expected.size) }.getOrNull()
            ?: return@withPermit false
        MessageDigest.isEqual(actual, expected)
    }

    private fun derive(password: String, salt: String, n: Int, r: Int, p: Int, size: Int): ByteArray =
        SCrypt.generate(
            password.toByteArray(StandardCharsets.UTF_8),
            salt.toByteArray(StandardCharsets.UTF_8),
            n,
            r,
            p,
            size,
        )

    private fun validParameters(n: Int, r: Int, p: Int, size: Int): Boolean =
        n == N && r == R && p == P && size == KEY_BYTES

    private fun <T> withPermit(action: () -> T): T {
        if (!permits.tryAcquire()) throw AuthUnavailableException("Password verification capacity is busy")
        return try {
            action()
        } finally {
            permits.release()
        }
    }

    private fun ByteArray.base64Url(): String = ENCODER.encodeToString(this)

    companion object {
        const val DUMMY_HASH =
            "scrypt\$16384\$8\$1\$bWVhdGJveC1kdW1teS1hdXRoLXYx\$" +
                "7oXDmmzQEtUDq-VK7IduWHxW2PhfjcoTvfAOwEjp7Pa1AfBriltGWsIO8w7jwi3dtEwnPFlXoctKmBQVhB_6nQ"
        private const val N = 16_384
        private const val R = 8
        private const val P = 1
        private const val KEY_BYTES = 64
        private const val SALT_BYTES = 16
        private const val ENCODED_PARTS = 6
        private const val SALT_PART = 4
        private const val PASSWORD_CONCURRENCY = 2
        private val SALT_LENGTH = 1..256
        private val ENCODER = Base64.getUrlEncoder().withoutPadding()
        private val DECODER = Base64.getUrlDecoder()
    }
}
