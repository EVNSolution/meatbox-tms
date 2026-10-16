package com.evnsolution.meatbox

import org.assertj.core.api.Assertions.assertThat
import tools.jackson.databind.json.JsonMapper

private val problemMapper = JsonMapper.builder().build()

/** Every error body must be the RFC 9457 shape, with the legacy `error` field equal to `code`. */
fun assertProblem(body: String, status: Int, code: String) {
    val json = problemMapper.readTree(body)
    assertThat(json.path("type").asString()).isEqualTo("about:blank")
    assertThat(json.path("title").asString()).isNotBlank()
    assertThat(json.path("status").asInt()).isEqualTo(status)
    assertThat(json.path("detail").asString()).isNotBlank().hasSizeLessThanOrEqualTo(300)
    assertThat(json.path("code").asString()).isEqualTo(code)
    assertThat(json.path("error").asString()).isEqualTo(code)
}
