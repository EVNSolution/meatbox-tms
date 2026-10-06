package com.evnsolution.meatbox.auth

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AuthHttpTest(
    @param:LocalServerPort private val port: Int,
) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val mapper = JsonMapper.builder().build()

    @Test
    fun `owns login registration session logout origin and account failure contracts`() {
        assertThat(request("/api/session").statusCode()).isEqualTo(401)

        val wrongOrigin = form(
            "/login",
            "username=tester&password=correct+horse+battery+staple",
            "https://evil.invalid",
        )
        assertThat(wrongOrigin.statusCode()).isEqualTo(403)
        val duplicate = form("/login", "username=tester&username=other&password=correct+horse+battery+staple")
        assertThat(duplicate.statusCode()).isEqualTo(400)

        val retiredRedirect = form(
            "/login",
            "username=tester&password=correct+horse+battery+staple&next=%2Fscenario",
        )
        assertThat(retiredRedirect.statusCode()).isEqualTo(303)
        assertThat(retiredRedirect.headers().firstValue("Location").orElse("")).isEqualTo("/")

        val login = form(
            "/login",
            "username=TeStEr&password=correct+horse+battery+staple&next=%2Fcombined%2F",
        )
        assertThat(login.statusCode()).isEqualTo(303)
        assertThat(login.headers().firstValue("Location").orElse("")).isEqualTo("/combined/")
        val setCookie = login.headers().firstValue("Set-Cookie").orElseThrow()
        assertThat(setCookie).contains("meatbox_session=", "HttpOnly", "SameSite=Strict", "Path=/")
        assertThat(setCookie).doesNotContain("Secure")
        val cookie = setCookie.substringBefore(';')

        val session = request("/api/session", cookie = cookie)
        assertThat(session.statusCode()).isEqualTo(200)
        assertThat(mapper.readTree(session.body()).at("/user/username").asString()).isEqualTo("tester")
        assertThat(session.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store")
        assertThat(session.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff")
        assertThat(session.headers().firstValue(AuthResponseFilter.AUTH_OWNER_HEADER).orElse("")).isEqualTo("kotlin")
        assertThat(session.headers().firstValue("Content-Security-Policy").orElse(""))
            .contains("default-src 'self'", "object-src 'none'", "form-action 'self'")
        val head = request("/api/session", method = "HEAD", cookie = cookie)
        assertThat(head.statusCode()).isEqualTo(200)
        assertThat(head.body()).isEmpty()

        val registered = form(
            "/dev/register",
            "invite=valid-invitation-code&username=new.user&" +
                "displayName=%EC%83%88+%EC%82%AC%EC%9A%A9%EC%9E%90&password=eight888",
        )
        assertThat(registered.statusCode()).isEqualTo(303)
        assertThat(registered.headers().firstValue("Location").orElse("")).isEqualTo("/login?registered=1")
        assertThat(Files.readString(accessFile)).contains("\"new.user\"", "\"usedBy\" : \"new.user\"")

        val logout = form("/logout", "", cookie = cookie)
        assertThat(logout.statusCode()).isEqualTo(303)
        assertThat(logout.headers().firstValue("Set-Cookie").orElse("")).contains("Max-Age=0")
        assertThat(request("/api/session", cookie = cookie).statusCode()).isEqualTo(401)

        Files.delete(accessFile)
        val unavailable = form("/login", "username=tester&password=correct+horse+battery+staple")
        assertThat(unavailable.statusCode()).isEqualTo(503)
        assertThat(accessFile).doesNotExist()
    }

    private fun form(
        path: String,
        body: String,
        origin: String = PUBLIC_ORIGIN,
        cookie: String? = null,
    ): HttpResponse<String> = request(
        path,
        method = "POST",
        cookie = cookie,
        body = body,
        headers = mapOf(
            "Origin" to origin,
            "Content-Type" to "application/x-www-form-urlencoded;charset=UTF-8",
        ),
    )

    private fun request(
        path: String,
        method: String = "GET",
        cookie: String? = null,
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse<String> {
        val publisher = body?.let(HttpRequest.BodyPublishers::ofString) ?: HttpRequest.BodyPublishers.noBody()
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).method(method, publisher)
        cookie?.let { builder.header("Cookie", it) }
        headers.forEach(builder::header)
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    companion object {
        private const val PUBLIC_ORIGIN = "http://127.0.0.1:4173"
        private val directory: Path = Files.createTempDirectory("meatbox-auth-http-")
        private val accessFile: Path = directory.resolve("access.json")

        init {
            val inviteHash = AuthService.digest("valid-invitation-code")
            Files.writeString(
                accessFile,
                NodeScryptFixture.accountJson(
                    """{"$inviteHash":{"createdAt":1,"expiresAt":9999999999999}}""",
                ),
            )
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.auth.enabled") { "true" }
            registry.add("meatbox.auth.access-file") { accessFile.toString() }
            registry.add("meatbox.auth.public-origin") { PUBLIC_ORIGIN }
        }

        @JvmStatic
        @AfterAll
        fun cleanup() {
            Files.deleteIfExists(accessFile)
            Files.deleteIfExists(directory)
        }
    }
}
