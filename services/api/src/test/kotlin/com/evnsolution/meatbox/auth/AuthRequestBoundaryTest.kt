package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest

class AuthRequestBoundaryTest {
    @Test
    fun `rejects duplicate and oversized form fields`() {
        val duplicate = request("username=one&username=two")
        assertThatThrownBy { FormParser().parse(duplicate) }.isInstanceOf(IllegalArgumentException::class.java)

        val oversized = request("padding=${"x".repeat(4 * 1024)}")
        assertThatThrownBy { FormParser().parse(oversized) }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `bounds rate keys and blocks the twenty first request for one trusted identity`() {
        var time = 1L
        val limiter = AccessRateLimiter { time }
        repeat(20) { assertThat(limiter.allow("203.0.113.1")).isTrue() }
        assertThat(limiter.allow("203.0.113.1")).isFalse()
        time += 15 * 60 * 1_000L
        assertThat(limiter.allow("203.0.113.1")).isTrue()
    }

    private fun request(body: String): MockHttpServletRequest = MockHttpServletRequest().apply {
        contentType = "application/x-www-form-urlencoded;charset=UTF-8"
        setContent(body.toByteArray())
    }
}
