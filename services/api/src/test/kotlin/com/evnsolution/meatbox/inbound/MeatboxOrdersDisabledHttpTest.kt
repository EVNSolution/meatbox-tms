package com.evnsolution.meatbox.inbound

import com.evnsolution.meatbox.assertProblem
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

/** With no `MEATBOX_INBOUND_TOKEN` the endpoint does not exist, even for a caller that sends some token. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MeatboxOrdersDisabledHttpTest(
    @param:LocalServerPort private val port: Int,
    @param:Autowired private val filters: ObjectProvider<MeatboxInboundFilter>,
    @param:Autowired private val controllers: ObjectProvider<MeatboxOrderController>,
) {
    @Test
    fun `answers 404 problem json and has neither the filter nor the controller`() {
        assertThat(filters.ifAvailable).isNull()
        assertThat(controllers.ifAvailable).isNull()
        val response = HttpClient.newHttpClient().send(
            HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/meatbox/orders"))
                .header("Authorization", "Bearer some-token-some-token").header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        assertThat(response.statusCode()).isIn(404, 405)
        assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json")
        if (response.statusCode() == 404) assertProblem(response.body(), 404, "NOT_FOUND")
    }
}
