package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class PasswordHasherTest {
    private val hasher = PasswordHasher()

    @Test
    fun `verifies Node crypto scrypt vectors using the literal UTF 8 salt string`() {
        val vectors = listOf(
            "correct horse battery staple" to
                NodeScryptFixture.ASCII_HASH,
            "암호🔐password" to
                NodeScryptFixture.UNICODE_HASH,
        )

        vectors.forEach { (password, encoded) ->
            assertThat(hasher.verify(password, encoded)).isTrue()
            assertThat(hasher.verify("$password!", encoded)).isFalse()
        }
    }

    @Test
    fun `rejects unsupported or malformed untrusted password parameters`() {
        val valid = NodeScryptFixture.ASCII_HASH

        assertThat(hasher.verify("correct horse battery staple", valid.replace("16384", "32768"))).isFalse()
        assertThat(hasher.verify("correct horse battery staple", "not-a-password-hash")).isFalse()
        assertThat(hasher.verify("correct horse battery staple", valid.substringBeforeLast('$') + "\$bad!"))
            .isFalse()
    }
}
