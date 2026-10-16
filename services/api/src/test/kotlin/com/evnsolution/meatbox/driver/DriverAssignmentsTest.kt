package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.auth.AuthSettings
import com.evnsolution.meatbox.auth.Role
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

class DriverAssignmentsTest {
    @TempDir lateinit var directory: Path
    private lateinit var file: Path
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setup() {
        file = directory.resolve("driver-assignments.json")
        val access = directory.resolve("access.json")
        val hash = "scrypt${'$'}16384${'$'}8${'$'}1${'$'}literal-salt_01${'$'}yWKt5d"
        val account = """"passwordHash":"$hash","createdAt":1,"disabled""""
        Files.writeString(
            access,
            """{"version":1,"invites":{},"users":{
              "kim":{"username":"kim","displayName":"김기사",$account:false,"role":"driver"},
              "gone":{"username":"gone","displayName":"퇴사",$account:true,"role":"driver"},
              "boss":{"username":"boss","displayName":"관리",$account:false,"role":"ops"},
              "old":{"username":"old","displayName":"예전",$account:false}}}""",
        )
        val service = AuthService(AuthSettings(access, URI("http://127.0.0.1:4173")))
        val provider = object : ObjectProvider<AuthService> {
            override fun getObject(): AuthService = service
            override fun getObject(vararg args: Any?): AuthService = service
            override fun getIfAvailable(): AuthService = service
            override fun getIfUnique(): AuthService = service
        }
        mvc = MockMvcBuilders.standaloneSetup(DriverAssignmentsController(DriverAssignments(file), provider, ORIGIN))
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts())).build()
        assertThat(service.roleOf("old")).isEqualTo(Role.OPS)
    }

    private fun put(vehicle: String, body: String, origin: String? = ORIGIN): MockHttpServletResponse {
        val request = MockMvcRequestBuilders.put("/api/ops/driver-assignments/$vehicle")
            .contentType("application/json").content(body)
        origin?.let { request.header("Origin", it) }
        return mvc.perform(request).andReturn().response
    }

    private fun list() = driverJson.readTree(
        mvc.perform(MockMvcRequestBuilders.get("/api/ops/driver-assignments")).andReturn().response.contentAsString,
    )

    @Test
    fun `lists driver accounts only and assigns and clears a vehicle`() {
        val first = list()
        assertThat(first.path("revision").asLong()).isZero()
        assertThat(first.path("drivers").toList().map { it.path("username").asString() }).containsExactly("gone", "kim")
        val gone = first.path("drivers").first { it.path("username").asString() == "gone" }
        assertThat(gone.path("disabled").asBoolean()).isTrue()

        assertThat(put("G1", """{"revision":0,"driver":"kim"}""").status).isEqualTo(200)
        assertThat(DriverAssignments(file).driverOf("G1")).isEqualTo("kim")
        val second = list()
        assertThat(second.path("assignments").first().path("known").asBoolean()).isTrue()
        assertThat(put("G1", """{"revision":1,"driver":null}""").status).isEqualTo(200)
        assertThat(DriverAssignments(file).driverOf("G1")).isNull()
        assertThat(list().path("revision").asLong()).isEqualTo(2)
    }

    @Test
    fun `refuses a missing origin, a stale revision and drivers that are not enabled driver accounts`() {
        assertProblem(put("G1", """{"revision":0,"driver":"kim"}""", null).contentAsString, 403, "ORIGIN_REQUIRED")
        val foreign = put("G1", """{"revision":0,"driver":"kim"}""", "https://evil.invalid")
        assertProblem(foreign.contentAsString, 403, "ORIGIN_REQUIRED")
        for (driver in listOf("gone", "boss", "old", "nobody")) {
            assertProblem(put("G1", """{"revision":0,"driver":"$driver"}""").contentAsString, 400, "DRIVER_NOT_FOUND")
        }
        put("G1", """{"revision":0,"driver":"kim"}""")
        val stale = put("G2", """{"revision":0,"driver":"kim"}""")
        assertProblem(stale.contentAsString, 409, "ASSIGNMENT_REVISION_CONFLICT")
        val malformed = listOf(
            "{", "[]", """{"revision":1}""", """{"revision":"1","driver":null}""", """{"revision":1,"driver":5}""",
            """{"revision":1,"driver":null,"extra":1}""",
        )
        for (body in malformed) assertProblem(put("G2", body).contentAsString, 400, "INVALID_INPUT")
        assertThat(DriverAssignments(file).view().assignments).containsOnlyKeys("G1")
    }

    @Test
    fun `keeps the file as a small sorted document and fails closed on a corrupt one`() {
        val store = DriverAssignments(file)
        assertThat(store.view().revision).isZero()
        store.assign(0, "G2", "kim")
        store.assign(1, "G1", "kim")
        val expected = """{"version":1,"revision":2,"assignments":{"G1":"kim","G2":"kim"}}"""
        assertThat(Files.readString(file)).isEqualTo(expected)
        Files.writeString(file, """{"version":2,"revision":1,"assignments":{}}""")
        assertThatThrownBy { store.view() }.isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.code).isEqualTo("DRIVER_ASSIGNMENTS_INVALID")
        }
    }

    companion object { private const val ORIGIN = "https://test.invalid" }
}
