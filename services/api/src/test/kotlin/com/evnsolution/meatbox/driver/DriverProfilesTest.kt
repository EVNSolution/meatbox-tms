package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.auth.AuthSettings
import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.ops.quietAlerts
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.beans.factory.ObjectProvider
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class DriverProfilesTest {
    @TempDir lateinit var directory: Path
    private lateinit var file: Path
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setup() {
        file = directory.resolve("driver-profiles.json")
        val access = directory.resolve("access.json")
        val hash = "scrypt${'$'}16384${'$'}8${'$'}1${'$'}literal-salt_01${'$'}yWKt5d"
        val account = """"passwordHash":"$hash","createdAt":1,"disabled""""
        Files.writeString(
            access,
            """{"version":1,"invites":{},"users":{
              "kim":{"username":"kim","displayName":"김기사",$account:false,"role":"driver"},
              "boss":{"username":"boss","displayName":"관리",$account:false,"role":"ops"}}}""",
        )
        val service = AuthService(AuthSettings(access, URI("http://127.0.0.1:4173")))
        val provider = object : ObjectProvider<AuthService> {
            override fun getObject(): AuthService = service
            override fun getObject(vararg args: Any?): AuthService = service
            override fun getIfAvailable(): AuthService = service
            override fun getIfUnique(): AuthService = service
        }
        mvc = MockMvcBuilders.standaloneSetup(DriverProfilesController(DriverProfiles(file), provider, ORIGIN))
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts())).build()
    }

    private fun put(username: String, body: String, origin: String? = ORIGIN): MockHttpServletResponse {
        val request = MockMvcRequestBuilders.put("/api/ops/driver-profiles/$username")
            .contentType("application/json").content(body)
        origin?.let { request.header("Origin", it) }
        return mvc.perform(request).andReturn().response
    }

    private fun list() = driverJson.readTree(
        mvc.perform(MockMvcRequestBuilders.get("/api/ops/driver-profiles")).andReturn().response.contentAsString,
    )

    @Test
    fun `lists driver accounts with empty profiles then saves, shows and removes one`() {
        val first = list()
        assertThat(first.path("drivers").toList().map { it.path("username").asString() }).containsExactly("kim")
        assertThat(first.path("drivers").first().path("region").isNull).isTrue()
        assertThat(first.path("drivers").first().path("capa").path("boxes").isNull).isTrue()

        val body = """{"revision":0,"profile":{"region":"강남","skill":"상","phone":" 010-0000-0000 ","address":" ",
            "capa":{"stops":30,"boxes":120.5,"weightKg":800.1234}}}"""
        assertThat(put("kim", body).status).isEqualTo(200)
        val row = list().path("drivers").first()
        assertThat(row.path("region").asString()).isEqualTo("강남")
        assertThat(row.path("phone").asString()).isEqualTo("010-0000-0000")
        assertThat(row.path("address").isNull).isTrue()
        assertThat(row.path("capa").path("stops").asInt()).isEqualTo(30)
        assertThat(row.path("capa").path("weightKg").asDouble()).isEqualTo(800.123)
        assertThat(put("kim", """{"revision":1,"profile":null}""").status).isEqualTo(200)
        assertThat(DriverProfiles(file).view().profiles).isEmpty()
        assertProblem(put("kim", """{"revision":2,"profile":null}""").contentAsString, 404, "PROFILE_NOT_FOUND")
    }

    @Test
    fun `refuses a missing origin, a stale revision, non-driver accounts and malformed profiles`() {
        val ok = """{"revision":0,"profile":{"region":"강남"}}"""
        assertProblem(put("kim", ok, null).contentAsString, 403, "ORIGIN_REQUIRED")
        assertProblem(put("boss", ok).contentAsString, 400, "DRIVER_NOT_FOUND")
        assertProblem(put("nobody", ok).contentAsString, 400, "DRIVER_NOT_FOUND")
        put("kim", ok)
        assertProblem(put("kim", ok).contentAsString, 409, "PROFILE_REVISION_CONFLICT")
        val bad = listOf(
            """{"revision":1,"profile":{"extra":"x"}}""", """{"revision":1,"profile":{"region":5}}""",
            """{"revision":1,"profile":{"capa":{"stops":1.5}}}""", """{"revision":1,"profile":{"capa":{"boxes":-1}}}""",
            """{"revision":1,"profile":{"capa":{"other":1}}}""", """{"revision":1,"profile":[]}""",
            """{"revision":1,"profile":{"phone":"${"1".repeat(51)}"}}""", """{"revision":1}""", "{",
        )
        for (body in bad) assertProblem(put("kim", body).contentAsString, 400, "INVALID_INPUT")
        assertThat(DriverProfiles(file).view().profiles["kim"]?.path("region")?.asString()).isEqualTo("강남")
    }

    @Test
    fun `keeps a profile of a removed account visible as unknown and fails closed on a corrupt file`() {
        val store = DriverProfiles(file)
        store.put(0, "gone", driverJson.readTree("""{"region":"성북"}"""))
        val rows = list().path("drivers").toList()
        assertThat(rows.map { it.path("username").asString() }).containsExactly("kim", "gone")
        assertThat(rows.last().path("known").asBoolean()).isFalse()
        Files.writeString(file, """{"version":2,"revision":1,"profiles":{}}""")
        assertThatThrownBy { store.view() }.isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.code).isEqualTo("DRIVER_PROFILES_INVALID")
        }
    }

    companion object { private const val ORIGIN = "https://test.invalid" }
}
