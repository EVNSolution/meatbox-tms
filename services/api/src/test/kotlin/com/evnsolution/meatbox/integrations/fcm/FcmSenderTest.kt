package com.evnsolution.meatbox.integrations.fcm

import com.evnsolution.meatbox.driver.DRIVER_DATE
import com.evnsolution.meatbox.driver.driverJson
import com.evnsolution.meatbox.driver.keys
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.time.Instant
import java.util.Base64

class FcmSenderTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `signs scoped JWT exchanges token and sends private generic notification`() {
        val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        var exchanges = 0
        var deliveries = 0
        val sender = FcmSender(account(keys), "test-project", FcmTransport { uri, headers, body, timeout ->
            assertThat(timeout.toMillis()).isBetween(1L, 4000L)
            if (uri == URI("https://oauth2.googleapis.com/token")) {
                exchanges++
                assertThat(headers["Content-Type"]).isEqualTo("application/x-www-form-urlencoded")
                assertAssertion(body, keys)
                FcmResponse(200, """{"access_token":"access-fixture","expires_in":3600,"token_type":"Bearer"}""")
            } else {
                deliveries++
                assertThat(uri.toString())
                    .isEqualTo("https://fcm.googleapis.com/v1/projects/test-project/messages:send")
                assertThat(headers["Authorization"]).isEqualTo("Bearer access-fixture")
                val message = driverJson.readTree(body).path("message")
                assertThat(message.path("token").asString()).isEqualTo("device-fixture")
                assertThat(message.path("android").path("priority").asString()).isEqualTo("HIGH")
                assertThat(message.path("android").path("notification").path("channel_id").asString())
                    .isEqualTo("meatbox-driver")
                assertThat(message.path("data").path("type").asString()).isEqualTo("ops_message")
                assertThat(message.path("data").path("vehicleId").asString()).isEqualTo("G1")
                assertThat(message.path("data").path("messageId").asString()).isEqualTo("message-1")
                assertThat(message.path("notification").path("body").asString()).isEqualTo("운영팀의 새 메시지가 있습니다.")
                FcmResponse(200, """{"name":"projects/test-project/messages/accepted-1"}""")
            }
        }, { NOW })
        repeat(2) { assertThat(sender.send(listOf("device-fixture"), DRIVER_DATE, "G1", "message-1"))
            .isEqualTo(PushSummary("sent", 1, 1, 0)) }
        assertThat(exchanges).isEqualTo(1)
        assertThat(deliveries).isEqualTo(2)
    }

    @Test
    fun `reports disabled failed partial and missing device without claiming delivery`() {
        val none = FcmTransport { _, _, _, _ -> error("Must not contact provider") }
        assertThat(FcmSender("", "", none).send(listOf("token"), DRIVER_DATE, "G1", "id").status)
            .isEqualTo("unconfigured")
        assertThat(FcmSender("/missing", "test-project", none).send(emptyList(), DRIVER_DATE, "G1", "id").status)
            .isEqualTo("no-device")
        assertThat(FcmSender("/missing", "test-project", none).send(listOf("token"), DRIVER_DATE, "G1", "id"))
            .isEqualTo(PushSummary("failed", 1, 0, 1))
        val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val key = account(keys)
        var count = 0
        val mixed = FcmSender(key, "test-project", FcmTransport { uri, _, _, _ ->
            if (uri.host == "oauth2.googleapis.com") {
                FcmResponse(200, """{"access_token":"access","expires_in":3600,"token_type":"Bearer"}""")
            } else if (++count == 1) FcmResponse(200, """{"name":"projects/test-project/messages/first"}""")
            else FcmResponse(404, """{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}""")
        })
        assertThat(mixed.send(listOf("one", "two"), DRIVER_DATE, "G1", "id"))
            .isEqualTo(PushSummary("partial", 2, 1, 1))
        val failed = FcmSender(key, "test-project", FcmTransport { _, _, _, _ ->
            FcmResponse(403, """{"error":"denied"}""")
        })
        assertThat(failed.send(listOf("one"), DRIVER_DATE, "G1", "id")).isEqualTo(PushSummary("failed", 1, 0, 1))
    }

    @Test
    fun `a route change goes out with its own type and text while the operator message stays as it was`() {
        val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val seen = mutableListOf<String>()
        val sender = FcmSender(account(keys), "test-project", FcmTransport { uri, _, body, _ ->
            if (uri.host == "oauth2.googleapis.com") {
                FcmResponse(200, """{"access_token":"access","expires_in":3600,"token_type":"Bearer"}""")
            } else {
                seen += body
                FcmResponse(200, """{"name":"projects/test-project/messages/ok"}""")
            }
        }, { NOW })
        val content = PushContent("route_changed", "미트박스 배송", "배차가 변경되었습니다. 순서 변경", "route-7")
        assertThat(sender.send(listOf("device"), DRIVER_DATE, "G1", content)).isEqualTo(PushSummary("sent", 1, 1, 0))
        val message = driverJson.readTree(seen.single()).path("message")
        assertThat(message.path("data").path("type").asString()).isEqualTo("route_changed")
        assertThat(message.path("data").path("messageId").asString()).isEqualTo("route-7")
        assertThat(message.path("data").path("body").asString()).isEqualTo("배차가 변경되었습니다. 순서 변경")
        assertThat(message.path("notification").path("body").asString()).isEqualTo("배차가 변경되었습니다. 순서 변경")
        assertThat(message.path("android").path("notification").path("channel_id").asString())
            .isEqualTo("meatbox-driver")
    }

    @Test
    fun `refreshes expired access tokens and refuses invalid successful provider responses`() {
        val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        var clock = NOW
        var exchanges = 0
        val sender = FcmSender(account(keys), "test-project", FcmTransport { uri, _, _, _ ->
            if (uri.host == "oauth2.googleapis.com") {
                exchanges++
                FcmResponse(200, """{"access_token":"access","expires_in":120,"token_type":"Bearer"}""")
            } else FcmResponse(200, "{}")
        }, { clock })
        assertThat(sender.send(listOf("one"), DRIVER_DATE, "G1", "id").status).isEqualTo("failed")
        clock = clock.plusSeconds(121)
        sender.send(listOf("one"), DRIVER_DATE, "G1", "id")
        assertThat(exchanges).isEqualTo(2)
    }

    private fun assertAssertion(form: String, keys: KeyPair) {
        assertThat(form).startsWith("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=")
        val jwt = URLDecoder.decode(form.substringAfter("&assertion="), UTF_8).split('.')
        val claims = driverJson.readTree(Base64.getUrlDecoder().decode(jwt[1]))
        assertThat(claims.path("iss").asString()).isEqualTo("test@example.iam.gserviceaccount.com")
        assertThat(claims.path("scope").asString()).isEqualTo("https://www.googleapis.com/auth/firebase.messaging")
        assertThat(claims.path("aud").asString()).isEqualTo("https://oauth2.googleapis.com/token")
        assertThat(claims.path("iat").asLong()).isEqualTo(NOW.epochSecond)
        assertThat(claims.path("exp").asLong()).isEqualTo(NOW.epochSecond + 3600)
        val verify = Signature.getInstance("SHA256withRSA")
        verify.initVerify(keys.public)
        verify.update("${jwt[0]}.${jwt[1]}".toByteArray(UTF_8))
        assertThat(verify.verify(Base64.getUrlDecoder().decode(jwt[2]))).isTrue()
    }

    private fun account(keys: KeyPair): String {
        val encoded = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(keys.private.encoded)
        val pem = "-----BEGIN PRIVATE KEY-----\n" + encoded +
            "\n-----END PRIVATE KEY-----\n"
        val path = directory.toRealPath().resolve("fixture-service-account.json")
        Files.writeString(path, driverJson.createObjectNode().put("type", "service_account")
            .put("project_id", "test-project").put("client_email", "test@example.iam.gserviceaccount.com")
            .put("private_key", pem).toString())
        return path.toString()
    }

    companion object { private val NOW = Instant.parse("2026-10-13T01:00:00Z") }
}
