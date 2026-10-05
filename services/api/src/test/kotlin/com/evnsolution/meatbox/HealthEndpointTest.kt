package com.evnsolution.meatbox

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class HealthEndpointTest(
    @param:LocalServerPort private val port: Int,
) {
    @Test
    fun `health endpoint reports that the application is up`() {
        val request = HttpRequest.newBuilder()
            .uri(URI("http://127.0.0.1:$port/actuator/health"))
            .GET()
            .build()

        val response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())

        assertEquals(200, response.statusCode())
        assertTrue(response.body().contains("\"status\":\"UP\""))
    }

    @Test
    fun `dispatch compatibility endpoints stay disabled by default`() {
        val request = HttpRequest.newBuilder()
            .uri(URI("http://127.0.0.1:$port/api/dispatch-data/manifest"))
            .GET()
            .build()

        val response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())

        assertEquals(404, response.statusCode())
    }
}
