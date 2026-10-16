package com.evnsolution.meatbox.auth

import com.evnsolution.meatbox.assertProblem
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.beans.factory.ObjectProvider
import org.springframework.mock.web.MockFilterChain
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class RoleAccessTest {
    @TempDir lateinit var directory: Path

    private val cookies = mapOf("ops" to Role.OPS, "driver" to Role.DRIVER, "nobody" to null)

    private val verifier = object : SessionVerifier {
        override val knowsRoles = true
        override fun verify(cookie: String?): String = identify(cookie).username
        override fun identify(cookie: String?): SessionIdentity {
            if (cookie == "broken") throw SessionUnavailableException("AUTH_UNAVAILABLE")
            if (cookie !in cookies) throw LoginRequiredException()
            return SessionIdentity(cookie.orEmpty(), cookies[cookie])
        }
    }

    private fun filter(source: SessionVerifier? = verifier) = RoleFilter(object : ObjectProvider<SessionVerifier> {
        override fun getObject(): SessionVerifier = source ?: error("none")
        override fun getObject(vararg args: Any?): SessionVerifier = getObject()
        override fun getIfAvailable(): SessionVerifier? = source
        override fun getIfUnique(): SessionVerifier? = source
    })

    private fun call(method: String, path: String, cookie: String?, source: SessionVerifier? = verifier):
        Pair<MockHttpServletResponse, MockFilterChain> {
        val request = MockHttpServletRequest(method, path).apply { cookie?.let { addHeader("Cookie", it) } }
        val response = MockHttpServletResponse()
        val chain = MockFilterChain()
        filter(source).doFilter(request, response, chain)
        return response to chain
    }

    private fun passes(method: String, path: String, cookie: String?) =
        call(method, path, cookie).second.request != null

    @Test
    fun `operators reach every api path and drivers only the driver app`() {
        val driverApp = "/api/dispatch-data/days/2026-10-05/driver/route"
        val business = listOf(
            "/api/dispatch-data/manifest", "/api/dispatch-data/regions", "/api/dispatch-data/destinations",
            "/api/dispatch-data/days/2026-10-05", "/api/dispatch-data/days/2026-10-05/state",
            "/api/dispatch-data/days/2026-10-05/commands", "/api/resources", "/api/resources/vehicles/G1",
            "/api/ops/alerts", "/api/ops/export", "/api/ops/driver-assignments", "/api/ops/driver-notes",
            "/api/ops/driver-profiles",
            "/api/telemetry/temperature/latest",
            "/api/something-new",
        )
        assertThat(passes("GET", driverApp, "ops")).isTrue()
        assertThat(passes("GET", driverApp, "driver")).isTrue()
        for (path in business) {
            assertThat(passes("GET", path, "ops")).describedAs("ops $path").isTrue()
            val (response, chain) = call("GET", path, "driver")
            assertThat(chain.request).describedAs("driver $path").isNull()
            assertThat(response.status).isEqualTo(403)
            assertProblem(response.contentAsString, 403, "ROLE_FORBIDDEN")
        }
    }

    @Test
    fun `an account with no role of ours may only ask who it is`() {
        assertThat(passes("GET", "/api/session", "nobody")).isTrue()
        assertThat(call("GET", "/api/dispatch-data/days/2026-10-05/driver/route", "nobody").first.status).isEqualTo(403)
        assertThat(call("GET", "/api/resources", "nobody").first.status).isEqualTo(403)
        assertThat(passes("GET", "/api/session", "driver")).isTrue()
    }

    @Test
    fun `requests without a valid session pass on so that the module answers them`() {
        for (cookie in listOf(null, "stranger", "broken")) {
            assertThat(passes("GET", "/api/resources", cookie)).describedAs("cookie $cookie").isTrue()
        }
    }

    @Test
    fun `token routes, pages and a verifier without roles are not filtered`() {
        assertThat(passes("POST", "/api/meatbox/orders", "driver")).isTrue()
        assertThat(passes("POST", "/api/telemetry/temperature", "driver")).isTrue()
        assertThat(call("GET", "/api/telemetry/temperature/latest", "driver").first.status).isEqualTo(403)
        assertThat(passes("GET", "/login", "driver")).isTrue()
        val legacy = SessionVerifier { "someone" }
        assertThat(call("GET", "/api/resources", "driver", legacy).second.request).isNotNull()
        assertThat(call("GET", "/api/resources", "driver", null).second.request).isNotNull()
    }

    @Test
    fun `passes the role to the controllers that bind drivers to their vehicles`() {
        val chain = call("GET", "/api/dispatch-data/days/2026-10-05/driver/route", "driver").second
        assertThat(chain.request?.getAttribute(RoleFilter.ROLE_ATTRIBUTE)).isEqualTo("driver")
    }

    @Test
    fun `accounts without a role are operators, new ones carry the role of their invitation`() {
        val file = directory.resolve("access.json")
        Files.writeString(file, NodeScryptFixture.accountJson())
        val store = AuthStore(file)
        assertThat(store.user("tester")?.role).isEqualTo(Role.OPS)

        val ops = store.issueInvite(60_000, 1, Role.OPS)
        val driver = store.issueInvite(60_000, 1, Role.DRIVER)
        assertThat(store.register("boss", null, "h", AuthService.digest(ops), 2).role).isEqualTo("ops")
        assertThat(store.register("kim", "김기사", "h", AuthService.digest(driver), 2).role).isEqualTo("driver")
        assertThat(store.user("kim")?.role).isEqualTo(Role.DRIVER)
        assertThat(Files.readString(file)).contains("\"version\" : 1", "\"role\" : \"driver\"")
    }

    @Test
    fun `an invitation from before roles existed makes an operator and an unknown invite role is refused`() {
        val file = directory.resolve("access.json")
        val old = "old-invitation-code-0001"
        val odd = "odd-invitation-code-0002"
        Files.writeString(
            file,
            """{"version":1,"users":{},"invites":{
              "${AuthService.digest(old)}":{"createdAt":1,"expiresAt":9999},
              "${AuthService.digest(odd)}":{"createdAt":1,"expiresAt":9999,"role":"admin"}}}""",
        )
        val store = AuthStore(file)
        assertThat(store.register("legacy", null, "h", AuthService.digest(old), 2).role).isEqualTo("ops")
        assertThatThrownBy { store.register("other", null, "h", AuthService.digest(odd), 2) }
            .isInstanceOfSatisfying(AccessException::class.java) { assertThat(it.code).isEqualTo("INVALID_INVITE") }
    }

    @Test
    fun `an unknown stored role is no role, and set-role changes it for the next request`() {
        val file = directory.resolve("access.json")
        val unknown = "\"disabled\":false,\"role\":\"admin\""
        Files.writeString(file, NodeScryptFixture.accountJson().replace("\"disabled\":false", unknown))
        val store = AuthStore(file)
        assertThat(store.user("tester")?.role).isNull()
        val service = AuthService(AuthSettings(file, URI("http://127.0.0.1:4173")))
        val cookie = "meatbox_session=" + service.login(LoginInput("tester", "correct horse battery staple")).token
        assertThat(service.identify(cookie).role).isNull()
        store.setRole("tester", Role.DRIVER)
        assertThat(service.identify(cookie).role).isEqualTo(Role.DRIVER)
        assertThat(service.driverAccounts().map { it.username }).containsExactly("tester")
        assertThat(service.session(AuthService.tokenFrom(cookie))?.role).isEqualTo("driver")
    }

    @Test
    fun `the admin command needs an explicit role and can change one`() {
        val file = directory.resolve("access.json")
        Files.writeString(file, NodeScryptFixture.accountJson())
        val secret = directory.resolve("invite.txt")
        val noRole = AuthProperties(
            accessFile = file.toString(), adminCommand = "issue-invite", adminOutput = secret.toString(),
        )
        assertThatThrownBy { run(noRole) }
            .hasMessageContaining("admin-role")
        assertThat(secret).doesNotExist()
        val set = AuthProperties(
            accessFile = file.toString(), adminCommand = "set-role", adminUsername = "tester", adminRole = "driver",
        )
        assertThat(run(set)).contains("Set tester to driver")
        assertThat(AuthStore(file).user("tester")?.role).isEqualTo(Role.DRIVER)
        val bad = set.copy(adminRole = "admin")
        assertThatThrownBy { run(bad) }.hasMessageContaining("admin-role")
    }

    private fun run(properties: AuthProperties): String {
        val out = java.io.ByteArrayOutputStream()
        AuthAdminRunner(properties, "none").execute(java.io.PrintStream(out))
        return out.toString()
    }
}
