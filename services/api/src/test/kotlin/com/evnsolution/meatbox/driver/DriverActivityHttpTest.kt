package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.ProblemExceptionHandler
import com.evnsolution.meatbox.assertProblem
import com.evnsolution.meatbox.auth.LoginRequiredException
import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchSessionFilter
import com.evnsolution.meatbox.integrations.fcm.FcmSender
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
        val anonymous = mvc.perform(MockMvcRequestBuilders.get("$PATH/events/e1")).andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
        val noOrigin = mvc.perform(MockMvcRequestBuilders.post("$PATH/events").header("Cookie", COOKIE)
            .contentType("application/json").content(EVENT)).andReturn().response
        assertProblem(noOrigin.contentAsString, 403, "ORIGIN_REQUIRED")
        val photo = mvc.perform(MockMvcRequestBuilders.multipart("$PATH/photos").file(file("image/jpeg", JPEG))
            .header("Cookie", COOKIE)).andReturn().response
        assertProblem(photo.contentAsString, 403, "ORIGIN_REQUIRED")
    }

    @Test
    fun `accepts an event with 202 and answers a resend and a lookup with the same body`() {
        val first = post("/events", EVENT)
        assertThat(first.status).isEqualTo(202)
        assertThat(first.contentAsString).contains("\"duplicate\":false")
        val second = post("/events", EVENT)
        assertThat(second.status).isEqualTo(202)
        val resent = first.contentAsString.replace("\"duplicate\":false", "\"duplicate\":true")
        assertThat(second.contentAsString).isEqualTo(resent)
        val lookup = get("/events/e-zone")
        assertThat(lookup.status).isEqualTo(200)
        assertThat(lookup.contentAsString).isEqualTo(second.contentAsString)
        assertProblem(get("/events/missing").contentAsString, 404, "REQUEST_NOT_FOUND")
        assertProblem(get("/events/bad%20id").contentAsString, 400, "INVALID_INPUT")
        assertProblem(post("/events", EVENT.replace("Z-07", "Z-08")).contentAsString, 409, "REQUEST_ID_MISMATCH")
    }

    @Test
    fun `rejects malformed event bodies and bounds their size`() {
        val extra = EVENT.replace("\"vehicleId\"", "\"extra\":1,\"vehicleId\"")
        assertProblem(post("/events", extra).contentAsString, 400, "INVALID_INPUT")
        assertProblem(post("/events", "{").contentAsString, 400, "INVALID_JSON")
        assertThat(post("/events", EVENT.replace("Z-07", "z".repeat(17_000))).status).isEqualTo(413)
        val unknown = EVENT.replace("zone_entered", "unknown")
        assertProblem(post("/events", unknown).contentAsString, 400, "INVALID_EVENT_TYPE")
    }

    @Test
    fun `reads the route stop detail history and an event result`() {
        assertThat(post("/events", DEPART).status).isEqualTo(202)
        val route = get("/route?vehicleId=G1")
        assertThat(route.status).isEqualTo(200)
        assertThat(driverJson.readTree(route.contentAsString).path("phase").asString()).isEqualTo("delivering")
        val stop = get("/stops/O3?vehicleId=G1")
        val first = driverJson.readTree(stop.contentAsString).path("orders").first()
        assertThat(first.path("orderId").asString()).isEqualTo("O3")
        assertThat(get("/history?vehicleId=G1").contentAsString).contains("\"items\":[]")
        assertThat(get("/events/e-go").status).isEqualTo(200)
        assertProblem(get("/stops/O3?vehicleId=G2").contentAsString, 404, "STOP_NOT_FOUND")
        assertProblem(get("/route?vehicleId=G9").contentAsString, 404, "DRIVER_VEHICLE_NOT_FOUND")
        assertThat(get("/route").status).isEqualTo(400)
        val anonymous = mvc.perform(MockMvcRequestBuilders.get("$PATH/history?vehicleId=G1")).andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
    }

    @Test
    fun `suggests a route order with or without a body and changes nothing`() {
        val before = get("/route?vehicleId=G1").contentAsString
        val bare = suggest("G1", null)
        assertThat(bare.status).isEqualTo(200)
        val json = driverJson.readTree(bare.contentAsString)
        assertThat(json.path("stopOrder").toList().map { it.asString() }).containsExactlyInAnyOrder("O1", "O3", "O4")
        assertThat(driverJson.readTree(before).path("revision").asLong()).isEqualTo(json.path("revision").asLong())
        assertThat(suggest("G1", "{}").status).isEqualTo(200)
        val locked = suggest("G1", """{"lockFirst":"O4"}""")
        assertThat(driverJson.readTree(locked.contentAsString).path("stopOrder").first().asString()).isEqualTo("O4")
        assertThat(get("/route?vehicleId=G1").contentAsString).isEqualTo(before)
        assertProblem(suggest("G1", """{"other":1}""").contentAsString, 400, "INVALID_INPUT")
        assertProblem(suggest("G1", """{"lockFirst":""}""").contentAsString, 400, "INVALID_INPUT")
        assertProblem(suggest("G1", "{").contentAsString, 400, "INVALID_JSON")
        assertProblem(suggest("G9", null).contentAsString, 404, "DRIVER_VEHICLE_NOT_FOUND")
        assertProblem(suggest("G1", """{"lockFirst":"nope"}""").contentAsString, 404, "STOP_NOT_FOUND")
        val suggestPath = "$PATH/route/suggest?vehicleId=G1"
        val noOrigin = mvc.perform(MockMvcRequestBuilders.post(suggestPath).header("Cookie", COOKIE))
            .andReturn().response
        assertProblem(noOrigin.contentAsString, 403, "ORIGIN_REQUIRED")
        val anonymous = mvc.perform(MockMvcRequestBuilders.post(suggestPath).header("Origin", ORIGIN))
            .andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
    }

    @Test
    fun `writes a delivery tip once per request and refuses what the engine refuses`() {
        val tip = """{"vehicleId":"G1","requestId":"tip-1","body":"뒷문 이용"}"""
        val first = post("/stops/O1/tip", tip)
        assertThat(first.status).isEqualTo(200)
        val json = driverJson.readTree(first.contentAsString)
        assertThat(json.path("stopId").asString()).isEqualTo("O1")
        assertThat(json.path("tip").path("body").asString()).isEqualTo("뒷문 이용")
        assertThat(json.path("duplicate").asBoolean()).isFalse()
        val resent = driverJson.readTree(post("/stops/O1/tip", tip).contentAsString)
        assertThat(resent.path("duplicate").asBoolean()).isTrue()
        val detail = driverJson.readTree(get("/stops/O1?vehicleId=G1").contentAsString)
        assertThat(detail.path("orders").first().path("tip").path("body").asString()).isEqualTo("뒷문 이용")
        assertProblem(post("/stops/O1/tip", tip.replace("뒷문 이용", "다른 팁")).contentAsString, 409, "REQUEST_ID_MISMATCH")
        val markup = tip.replace("tip-1", "tip-2").replace("뒷문 이용", "<b>")
        assertProblem(post("/stops/O1/tip", markup).contentAsString, 400, "INVALID_OPERATION")
        assertProblem(post("/stops/O1/tip", "{").contentAsString, 400, "INVALID_JSON")
        val numeric = """{"vehicleId":"G1","requestId":"t","body":1}"""
        assertProblem(post("/stops/O1/tip", numeric).contentAsString, 400, "INVALID_INPUT")
        val extra = """{"vehicleId":"G1","requestId":"t","body":"x","extra":1}"""
        assertProblem(post("/stops/O1/tip", extra).contentAsString, 400, "INVALID_INPUT")
        assertProblem(post("/stops/nope/tip", tip.replace("tip-1", "tip-4")).contentAsString, 404, "STOP_NOT_FOUND")
        val noOrigin = mvc.perform(MockMvcRequestBuilders.post("$PATH/stops/O1/tip").header("Cookie", COOKIE)
            .contentType("application/json").content(tip)).andReturn().response
        assertProblem(noOrigin.contentAsString, 403, "ORIGIN_REQUIRED")
        val anonymous = mvc.perform(MockMvcRequestBuilders.post("$PATH/stops/O1/tip").header("Origin", ORIGIN)
            .contentType("application/json").content(tip)).andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
    }

    @Test
    fun `the route answers 304 for an unchanged poll and the vehicles list needs a session`() {
        val first = get("/route?vehicleId=G1")
        val etag = first.getHeader("ETag").orEmpty()
        assertThat(first.status).isEqualTo(200)
        assertThat(etag).startsWith("W/\"route-")
        fun conditional(tag: String) = mvc.perform(
            MockMvcRequestBuilders.get("$PATH/route?vehicleId=G1").header("Cookie", COOKIE)
                .header("If-None-Match", tag),
        ).andReturn().response
        val same = conditional(etag)
        assertThat(same.status).isEqualTo(304)
        assertThat(same.contentAsString).isEmpty()
        assertThat(conditional("W/\"route-other\"").status).isEqualTo(200)
        assertThat(post("/events", DEPART).status).isEqualTo(202)
        assertThat(conditional(etag).status).isEqualTo(200)
        assertThat(get("/route?vehicleId=G1").getHeader("ETag")).isNotEqualTo(etag)

        val vehicles = get("/vehicles")
        assertThat(vehicles.status).isEqualTo(200)
        val json = driverJson.readTree(vehicles.contentAsString)
        assertThat(json.path("vehicles").size()).isEqualTo(2)
        assertThat(json.path("operable").asBoolean()).isTrue()
        val anonymous = mvc.perform(MockMvcRequestBuilders.get("$PATH/vehicles")).andReturn().response
        assertProblem(anonymous.contentAsString, 401, "LOGIN_REQUIRED")
        assertProblem(get("/route?vehicleId=G9").contentAsString, 404, "DRIVER_VEHICLE_NOT_FOUND")
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
        assertProblem(get("/photos/00000000-0000-4000-8000-000000000000").contentAsString, 404, "PHOTO_NOT_FOUND")
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

    private fun suggest(vehicleId: String, body: String?): MockHttpServletResponse {
        val request = MockMvcRequestBuilders.post("$PATH/route/suggest?vehicleId=$vehicleId")
            .header("Cookie", COOKIE).header("Origin", ORIGIN)
        return mvc.perform(if (body == null) request else request.contentType("application/json").content(body))
            .andReturn().response
    }

    private fun get(path: String): MockHttpServletResponse =
        mvc.perform(MockMvcRequestBuilders.get(PATH + path).header("Cookie", COOKIE)).andReturn().response

    companion object {
        private const val ORIGIN = "https://test.invalid"
        private const val COOKIE = "meatbox_session=fixture"
        private const val PATH = "/api/dispatch-data/days/$DRIVER_DATE/driver"
        private val JPEG = DriverLocationPhotoTest.JPEG
        private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0)
        private const val DEPART = """{"eventId":"e-go","type":"departed","occurredAt":"2026-10-13T10:41:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":{}}"""
        private const val EVENT = """{"eventId":"e-zone","type":"zone_entered","occurredAt":"2026-10-13T10:41:00+09:00",
            "date":"$DRIVER_DATE","vehicleId":"G1","payload":{"zoneId":"Z-07"}}"""
    }
}
