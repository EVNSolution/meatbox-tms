package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.legacy.CustomRegions
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

class RegionsTest {
    @TempDir lateinit var directory: Path
    private val mapper = JsonMapper.builder().build()
    private lateinit var regions: CustomRegions
    private lateinit var reader: DispatchDataReader
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setup() {
        val data = directory.resolve("data")
        Files.createDirectories(data.resolve("days"))
        val manifest = """{"schemaVersion":1,"defaultDate":"2026-10-13","dates":[{"date":"2026-10-13"}]}"""
        Files.writeString(data.resolve("manifest.json"), manifest)
        Files.writeString(data.resolve("regions.geojson"), collection("P1", "준비 권역"))
        regions = CustomRegions(directory.resolve("regions-custom.json"))
        reader = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), data), null, regions)
        val store = DispatchStore(reader, directory.resolve("state"))
        mvc = MockMvcBuilders.standaloneSetup(RegionsController(regions, store, ORIGIN))
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts())).build()
    }

    private fun collection(id: String, label: String, ring: String = SQUARE) =
        """{"type":"FeatureCollection","features":[{"type":"Feature",
        "properties":{"zoneId":"$id","label":"$label","extra":1},
        "geometry":{"type":"Polygon","coordinates":[$ring]}}]}"""

    private fun put(body: String, origin: String? = ORIGIN): MockHttpServletResponse {
        val request = MockMvcRequestBuilders.put("/api/ops/regions").contentType("application/json").content(body)
        origin?.let { request.header("Origin", it) }
        return mvc.perform(request).andReturn().response
    }

    private fun save(revision: Int, regionsJson: String, origin: String? = ORIGIN) =
        put("""{"revision":$revision,"regions":$regionsJson}""", origin)

    private fun read() = mvc.perform(MockMvcRequestBuilders.get("/api/ops/regions")).andReturn().response

    private fun get() = mapper.readTree(read().contentAsString)

    private fun zoneId(bytes: ByteArray) =
        mapper.readTree(bytes).path("features").first().path("properties").path("zoneId").asString()

    private fun problem(response: MockHttpServletResponse, status: Int, code: String) =
        assertProblem(response.contentAsString, status, code)

    private fun prepared() = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), directory.resolve("data")))

    @Test
    fun `serves the prepared zones until zones are saved, these then, and the prepared ones again after removal`() {
        val first = get()
        assertThat(first.path("custom").asBoolean()).isFalse()
        assertThat(zoneId(mapper.writeValueAsBytes(first.path("regions")))).isEqualTo("P1")

        assertThat(save(0, collection("C1", " 강남 ")).status).isEqualTo(200)
        val saved = get()
        assertThat(saved.path("custom").asBoolean()).isTrue()
        assertThat(saved.path("revision").asLong()).isEqualTo(1)
        val properties = saved.path("regions").path("features").first().path("properties")
        assertThat(properties.path("label").asString()).isEqualTo("강남")
        assertThat(properties.has("extra")).isFalse()
        assertThat(zoneId(reader.regions(null).bytes)).isEqualTo("C1")
        assertThat(reader.regions(null).etag).isNotEqualTo(prepared().regions(null).etag)

        assertThat(save(1, "null").status).isEqualTo(200)
        assertThat(get().path("custom").asBoolean()).isFalse()
        assertThat(get().path("revision").asLong()).isEqualTo(2)
        assertThat(zoneId(reader.regions(null).bytes)).isEqualTo("P1")
    }

    @Test
    fun `refuses a missing origin, a stale revision and collections that are not clean polygons`() {
        val ok = collection("C1", "강남")
        problem(save(0, ok, null), 403, "ORIGIN_REQUIRED")
        save(0, ok)
        problem(save(0, ok), 409, "REGIONS_REVISION_CONFLICT")
        val open = "[[127.0,37.0],[128.0,37.0],[128.0,38.0],[127.0,38.0]]"
        val outside = "[[127.0,37.0],[128.0,37.0],[128.0,91.0],[127.0,38.0],[127.0,37.0]]"
        val point = """{"properties":{"zoneId":"A"},"geometry":{"type":"Point","coordinates":[1,2]}}"""
        val twice = collection("A", "x").replace("""]}}]}""", """]}},${collection("A", "y").substringAfter("[")}""")
        val bad = listOf(
            collection("C1", "x", open), collection("C1", "x", outside), collection("bad id", "x"),
            collection("", "x"), """{"type":"FeatureCollection","features":[]}""", """{"type":"Feature"}""",
            """{"type":"FeatureCollection","features":[$point]}""", twice,
        )
        for (regionsJson in bad) problem(save(1, regionsJson), 400, "INVALID_REGIONS")
        for (body in listOf("{", """{"revision":1}""", """{"revision":"1","regions":null}""")) {
            problem(put(body), 400, "INVALID_INPUT")
        }
        assertThat(get().path("revision").asLong()).isEqualTo(1)
    }

    @Test
    fun `a corrupt file stops the editor but the readers fall back to the prepared zones`() {
        Files.writeString(directory.resolve("regions-custom.json"), """{"version":9,"revision":1,"regions":null}""")
        assertThat(regions.bytes()).isNull()
        assertThat(zoneId(reader.regions(null).bytes)).isEqualTo("P1")
        problem(read(), 500, "REGIONS_CUSTOM_INVALID")
    }

    companion object {
        private const val ORIGIN = "https://test.invalid"
        private const val SQUARE = "[[127.0,37.0],[128.0,37.0],[128.0,38.0],[127.0,38.0],[127.0,37.0]]"
    }
}
