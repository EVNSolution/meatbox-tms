package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.assertProblem
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipInputStream

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ExportHttpTest(@param:LocalServerPort private val port: Int) {
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = JsonMapper.builder().build()

    @Test
    fun `needs a session on every export path`() {
        for ((method, path) in listOf("POST" to "", "GET" to "", "GET" to "/00000000-0000-4000-8000-000000000000",
            "GET" to "/00000000-0000-4000-8000-000000000000/download")) {
            val response = send(method, path, null, if (method == "POST") "{}" else null)
            assertThat(response.statusCode()).describedAs("$method $path").isEqualTo(401)
            assertProblem(response.body(), 401, "LOGIN_REQUIRED")
        }
    }

    @Test
    fun `makes an archive in the background and hands it out with the hash that the status shows`() {
        val body = """{"from":"2026-10-01","to":"2026-10-31","include":["resources","orders"]}"""
        val started = send("POST", "", COOKIE, body)
        assertThat(started.statusCode()).isEqualTo(202)
        val job = json.readTree(started.body())
        assertThat(job.path("state").asString()).isEqualTo("running")
        assertThat(job.path("requestedBy").asString()).isEqualTo("fixture-user")
        assertThat(job.path("range").path("from").asString()).isEqualTo("2026-10-01")
        val id = job.path("jobId").asString()

        val done = awaitDone(id)
        assertThat(done.path("download").asString()).isEqualTo("/api/ops/export/$id/download")
        val download = download("/$id/download")
        assertThat(download.statusCode()).isEqualTo(200)
        assertThat(download.headers().firstValue("Content-Type").orElse("")).isEqualTo("application/zip")
        assertThat(download.headers().firstValue("Content-Disposition").orElse("")).contains("meatbox-export-$id.zip")
        val bytes = download.body()
        assertThat(bytes.size.toLong()).isEqualTo(done.path("bytes").asLong())
        assertThat(sha256(bytes)).isEqualTo(done.path("sha256").asString())
        val names = ZipInputStream(bytes.inputStream()).use { zip ->
            generateSequence { zip.nextEntry }.map { it.name }.toList()
        }
        assertThat(names).containsExactly("manifest.json")

        val listed = json.readTree(send("GET", "", COOKIE, null).body())
        assertThat(listed.path("exports").toList().map { it.path("jobId").asString() }).contains(id)
    }

    @Test
    fun `answers 404 for an unknown job and 400 for a bad body`() {
        val missing = send("GET", "/00000000-0000-4000-8000-000000000000", COOKIE, null)
        assertThat(missing.statusCode()).isEqualTo(404)
        assertProblem(missing.body(), 404, "EXPORT_NOT_FOUND")
        assertThat(send("GET", "/not-an-id/download", COOKIE, null).statusCode()).isEqualTo(404)
        val bodies = listOf(
            """{"from":"2026-02-30"}""", """{"include":["auth"]}""", """{"include":"orders"}""", """{"x":1}""",
            """{"from":5}""",
        )
        for (body in bodies) {
            val bad = send("POST", "", COOKIE, body)
            assertThat(bad.statusCode()).describedAs(body).isEqualTo(400)
            assertProblem(bad.body(), 400, "INVALID_EXPORT")
        }
    }

    private fun awaitDone(id: String): JsonNode {
        repeat(100) {
            val status = json.readTree(send("GET", "/$id", COOKIE, null).body())
            if (status.path("state").asString() != "running") {
                assertThat(status.path("state").asString()).isEqualTo("done")
                return status
            }
            Thread.sleep(50)
        }
        error("export did not finish")
    }

    private fun request(method: String, path: String, cookie: String?, body: String?): HttpRequest {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/ops/export$path"))
        cookie?.let { builder.header("Cookie", it) }
        if (body != null) builder.header("Content-Type", "application/json")
        builder.method(method, body?.let(HttpRequest.BodyPublishers::ofString) ?: HttpRequest.BodyPublishers.noBody())
        return builder.build()
    }

    private fun send(method: String, path: String, cookie: String?, body: String?): HttpResponse<String> =
        client.send(request(method, path, cookie, body), HttpResponse.BodyHandlers.ofString())

    private fun download(path: String): HttpResponse<ByteArray> =
        client.send(request("GET", path, COOKIE, null), HttpResponse.BodyHandlers.ofByteArray())

    companion object {
        private const val COOKIE = "session=valid"
        private val directory: Path = Files.createTempDirectory("meatbox-export-http-").toRealPath()
        private val dataDirectory: Path = Files.createDirectories(directory.resolve("data"))
        private val stateDirectory: Path = Files.createDirectory(directory.resolve("state"))
        private val sessionServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/session") { exchange: HttpExchange ->
                val valid = exchange.requestHeaders.getFirst("Cookie") == COOKIE
                val reply = if (valid) """{"user":{"username":"fixture-user"}}""" else """{"error":"LOGIN_REQUIRED"}"""
                val body = reply.toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(if (valid) 200 else 401, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
        }

        init {
            Files.createDirectories(dataDirectory.resolve("days"))
            Files.writeString(
                dataDirectory.resolve("manifest.json"),
                """{"schemaVersion":1,"defaultDate":"2026-10-05","dates":[{"date":"2026-10-05"}],""" +
                    """"source":{"csvSha256":"x"}}""",
            )
            Files.writeString(dataDirectory.resolve("days/2026-10-05.json"), """{"date":"2026-10-05","orders":[]}""")
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("meatbox.compat.enabled") { "true" }
            registry.add("meatbox.compat.legacy-api-origin") { "http://127.0.0.1:${sessionServer.address.port}" }
            registry.add("meatbox.compat.dispatch-data-dir") { dataDirectory.toString() }
            registry.add("meatbox.dispatch.enabled") { "true" }
            registry.add("meatbox.dispatch.state-dir") { stateDirectory.toString() }
            registry.add("meatbox.dispatch.public-origin") { "http://127.0.0.1:4173" }
        }

        @JvmStatic
        @AfterAll
        fun closeFixtures() {
            sessionServer.stop(0)
            directory.toFile().deleteRecursively()
        }
    }
}
