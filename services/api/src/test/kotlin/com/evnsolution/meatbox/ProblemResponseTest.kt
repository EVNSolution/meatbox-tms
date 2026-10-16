package com.evnsolution.meatbox

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.json.JsonMapper

class ProblemResponseTest {
    private val mvc: MockMvc = MockMvcBuilders.standaloneSetup(Boom())
        .setControllerAdvice(ProblemExceptionHandler()).build()

    @Test
    fun `maps a dispatch exception to a problem body whose error equals code`() {
        val response = mvc.perform(get("/conflict")).andReturn().response
        assertThat(response.status).isEqualTo(409)
        assertThat(response.contentType).startsWith("application/problem+json")
        assertProblem(response.contentAsString, 409, "REVISION_CONFLICT")
        val json = JsonMapper.builder().build().readTree(response.contentAsString)
        assertThat(json.path("detail").asString()).isEqualTo("Reload and retry.")
        assertThat(json.path("title").asString()).isEqualTo("Revision conflict")
    }

    @Test
    fun `keeps Retry-After on 429`() {
        val response = mvc.perform(get("/limited")).andReturn().response
        assertThat(response.status).isEqualTo(429)
        assertThat(response.getHeader("Retry-After")).isEqualTo("60")
        assertProblem(response.contentAsString, 429, "COMMAND_RATE_LIMITED")
    }

    @Test
    fun `hides the message of an unhandled exception`() {
        val response = mvc.perform(get("/crash")).andReturn().response
        assertThat(response.status).isEqualTo(500)
        assertThat(response.contentType).startsWith("application/problem+json")
        assertProblem(response.contentAsString, 500, "INTERNAL_ERROR")
        assertThat(response.contentAsString).doesNotContain("secret-path").doesNotContain("IllegalStateException")
    }

    @Test
    fun `answers unknown paths and wrong methods in problem format`() {
        val missing = mvc.perform(get("/nope")).andReturn().response
        assertThat(missing.status).isEqualTo(404)
        assertThat(missing.contentType).startsWith("application/problem+json")
        assertProblem(missing.contentAsString, 404, "NOT_FOUND")
        assertThat(missing.contentAsString).doesNotContain("nope")

        val wrongMethod = mvc.perform(post("/crash")).andReturn().response
        assertThat(wrongMethod.status).isEqualTo(405)
        assertThat(wrongMethod.getHeader("Allow")).contains("GET")
        assertProblem(wrongMethod.contentAsString, 405, "METHOD_NOT_ALLOWED")
    }

    @RestController
    class Boom {
        @GetMapping("/conflict")
        fun conflict(): Unit = throw DispatchException(409, "REVISION_CONFLICT", "Reload and retry.")

        @GetMapping("/limited")
        fun limited(): Unit = throw DispatchException(429, "COMMAND_RATE_LIMITED", "Slow down.")

        @GetMapping("/crash")
        fun crash(): Unit = throw IllegalStateException("secret-path /var/data/x")
    }
}
