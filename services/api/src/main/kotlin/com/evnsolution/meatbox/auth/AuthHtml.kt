package com.evnsolution.meatbox.auth

internal object AuthHtml {
    fun loginError(): String = page(
        "<p class=\"error\" role=\"alert\">아이디와 비밀번호를 확인해 주세요.</p>",
    )

    fun registerError(field: Pair<String, String>?): String {
        val feedback = field?.let { (name, message) ->
            "<input name=\"${escape(name)}\" aria-invalid=\"true\">" +
                "<p id=\"${escape(name)}-feedback\">${escape(message)}</p>"
        }.orEmpty()
        return page("<p class=\"error\" role=\"alert\">입력값을 확인해 주세요.</p>$feedback")
    }

    fun originError(): String = page(
        "<p class=\"error\" role=\"alert\">로그인 페이지에서 다시 시도해 주세요.</p>",
    )

    fun unavailable(): String = page(
        "<p class=\"error\" role=\"alert\">" +
            "서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>",
    )

    fun limited(): String = page(
        "<p class=\"error\" role=\"alert\">접근 요청이 많습니다. 잠시 후 다시 시도해 주세요.</p>",
    )

    private fun page(content: String): String =
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>미트박스 TMS</title></head>" +
            "<body><main><section class=\"auth-card\">$content</section></main></body></html>"

    private fun escape(value: String): String = value.replace("&", "&amp;").replace("<", "&lt;")
        .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
}
