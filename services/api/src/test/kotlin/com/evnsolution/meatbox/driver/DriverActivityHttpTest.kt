package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchSessionFilter
import com.evnsolution.meatbox.ops.quietAlerts
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.mock.web.MockMultipartFile
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder
import java.nio.file.Path

class DriverActivityHttpTest {
    @TempDir lateinit var directory: Path
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setup() {
        val filter = DispatchSessionFilter(SessionVerifier { cookie ->
            if (cookie != "meatbox_session=fixture") throw LoginRequiredException()
            "demo"
        })
        val controller = DriverController(routeFixture(directory).driver, FcmSender("", ""), ORIGIN)
        mvc = MockMvcBuilders.standaloneSetup(controller)
            .setControllerAdvice(ProblemExceptionHandler(quietAlerts()))
            .addFilters<StandaloneMockMvcBuilder>(filter).build()
    }

    @Test
    fun `protects the new routes with the session and origin`() {
        val anonymous = mvc.perform(MockMvcRequestBuilders.get("$PATH/photos/$NO_PHOTO")).andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
        val noOrigin = mvc.perform(MockMvcRequestBuilders.post("$PATH/locations").header("Cookie", COOKIE)
            .contentType("application/json").content("{}")).andReturn().response
        assertProblem(noOrigin.contentAsString, 403, "ORIGIN_REQUIRED")
        val photo = mvc.perform(MockMvcRequestBuilders.multipart("$PATH/photos").file(file("image/jpeg", JPEG))
            .header("Cookie", COOKIE)).andReturn().response
        assertProblem(photo.contentAsString, 403, "ORIGIN_REQUIRED")
    }

    @Test
    fun `accepts location batches up to 200 samples and 64 KiB`() {
        fun batch(count: Int) = """{"vehicleId":"G1","samples":[${(0 until count).joinToString(",") {
            """{"at":"2026-10-13T09:00:%02d+09:00","lat":37.5,"lng":127.0}""".format(it % 60)
        }}]}"""
        assertThat(post("/locations", batch(200)).status).isEqualTo(202)
        assertProblem(post("/locations", batch(201)).contentAsString, 400, "INVALID_INPUT")
        assertProblem(post("/locations", """{"vehicleId":"G1","samples":[]}""").contentAsString, 400, "INVALID_INPUT")
        val outside = """{"vehicleId":"G1","samples":[{"at":"2026-10-13T09:00:00+09:00","lat":99,"lng":127}]}"""
        assertProblem(post("/locations", outside).contentAsString, 400, "INVALID_INPUT")
        assertThat(post("/locations", " ".repeat(65_537)).status).isEqualTo(413)
    }

    @Test
    fun `uploads and downloads a photo with identical bytes and rejects the rest`() {
        val uploaded = upload("image/jpeg", JPEG)
        assertThat(uploaded.status).isEqualTo(201)
        val json = driverJson.readTree(uploaded.contentAsString)
        assertThat(json.path("bytes").asInt()).isEqualTo(JPEG.size)
        val photo = get("/photos/${json.path("photoId").asString()}")
        assertThat(photo.status).isEqualTo(200)
        assertThat(photo.contentType).isEqualTo("image/jpeg")
        assertThat(photo.contentAsByteArray).isEqualTo(JPEG)
        assertThat(upload("image/png", PNG).status).isEqualTo(201)
        assertProblem(upload("image/jpeg", jpeg(6)).contentAsString, 413, "PHOTO_TOO_LARGE")
        assertThat(upload("image/jpeg", jpeg(5)).status).isEqualTo(201)
        assertProblem(upload("image/gif", "GIF89a".toByteArray()).contentAsString, 415, "UNSUPPORTED_PHOTO_TYPE")
        assertProblem(upload("image/jpeg", "GIF89a".toByteArray()).contentAsString, 415, "UNSUPPORTED_PHOTO_TYPE")
        assertProblem(get("/photos/..%2F..%2Fdriver-$DRIVER_DATE").contentAsString, 400, "INVALID_PHOTO_ID")
        assertProblem(get("/photos/not-a-photo").contentAsString, 400, "INVALID_PHOTO_ID")
        assertProblem(get("/photos/$NO_PHOTO").contentAsString, 404, "PHOTO_NOT_FOUND")
    }

    private fun jpeg(mebibytes: Int) = ByteArray(mebibytes * 1024 * 1024) { 1 }.also { JPEG.copyInto(it) }

    private fun file(type: String, bytes: ByteArray) = MockMultipartFile("file", "photo", type, bytes)

    private fun upload(type: String, bytes: ByteArray): MockHttpServletResponse = mvc.perform(
        MockMvcRequestBuilders.multipart("$PATH/photos").file(file(type, bytes))
            .header("Cookie", COOKIE).header("Origin", ORIGIN),
    ).andReturn().response

    private fun post(path: String, body: String): MockHttpServletResponse = mvc.perform(
        MockMvcRequestBuilders.post(PATH + path).header("Cookie", COOKIE).header("Origin", ORIGIN)
            .contentType("application/json").content(body),
    ).andReturn().response

    private fun get(path: String): MockHttpServletResponse =
        mvc.perform(MockMvcRequestBuilders.get(PATH + path).header("Cookie", COOKIE)).andReturn().response

    companion object {
        private const val ORIGIN = "https://test.invalid"
        private const val COOKIE = "meatbox_session=fixture"
        private const val PATH = "/api/dispatch-data/days/$DRIVER_DATE/driver"
        private val JPEG = DriverLocationPhotoTest.JPEG
        private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0)
        private const val NO_PHOTO = "00000000-0000-4000-8000-000000000000"
    }
}
