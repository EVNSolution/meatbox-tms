package com.evnsolution.meatbox.eta

import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** A local HTTP server that stands in for OSRM or VROOM: every request is recorded and answered by [handler]. */
class MockEngine(@Volatile var handler: (Request) -> Reply) : AutoCloseable {
    class Request(val method: String, val uri: String, val body: String)

    class Reply(val status: Int = 200, val body: String = "", val delayMillis: Long = 0)

    val requests = CopyOnWriteArrayList<Request>()

    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
        executor = Executors.newCachedThreadPool { task -> Thread(task).apply { isDaemon = true } }
        createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes().decodeToString()
            val request = Request(exchange.requestMethod, exchange.requestURI.toString(), body)
            requests += request
            val reply = handler(request)
            if (reply.delayMillis > 0) Thread.sleep(reply.delayMillis)
            val bytes = reply.body.toByteArray()
            runCatching {
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(reply.status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
                if (bytes.isNotEmpty()) exchange.responseBody.write(bytes)
            }
            exchange.close()
        }
        start()
    }

    val url: String get() = "http://127.0.0.1:${server.address.port}"

    override fun close() = server.stop(0)

    companion object {
        /** The coordinates `lng,lat;lng,lat` of an OSRM table request. */
        fun coordinates(uri: String): List<EtaPoint> = uri.substringAfter("/car/").substringBefore('?').split(';')
            .map { it.split(',').let { (lng, lat) -> EtaPoint(lat.toDouble(), lng.toDouble()) } }

        /**
         * A table answer with its own road model: 10,000 s and 100 km per degree of longitude, so a test can tell it
         * from the straight-line model (about 17,700 s per degree).
         */
        fun table(uri: String): Reply {
            val points = coordinates(uri)
            fun grid(unit: Double) = points.joinToString(",", "[", "]") { from ->
                points.joinToString(",", "[", "]") { to -> Math.round(Math.abs(from.lng - to.lng) * unit).toString() }
            }
            return Reply(body = """{"code":"Ok","durations":${grid(10_000.0)},"distances":${grid(100_000.0)}}""")
        }
    }
}
