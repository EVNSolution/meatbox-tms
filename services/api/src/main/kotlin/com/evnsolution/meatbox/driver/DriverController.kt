package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.integrations.fcm.FcmSender
import com.evnsolution.meatbox.integrations.fcm.PushSummary
import org.springframework.http.HttpStatus

import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.dispatch.DispatchException
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.multipart.MultipartFile
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode

// One controller owns every /driver route so they share a single limiter, Origin check and body reader.
@Suppress("TooManyFunctions")
@RestController
@RequestMapping("/api/dispatch-data/days/{date}/driver")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverController(
    private val store: DriverStore,
    private val sender: FcmSender,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    private val limits = mutableMapOf<String, Window>()

    @PutMapping("/push-token")
    fun register(@PathVariable date: String, request: HttpServletRequest): Map<String, Boolean> {
        val body = mutation(request, setOf("vehicleId", "token", "deviceId", "platform"))
        if (string(body, "platform", PLATFORM_LENGTH) != "android") {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_PLATFORM")
        }
        val session = AuthService.tokenFrom(request.getHeader("Cookie"))
            ?: driverFail(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")
        store.register(date, username(request), AuthService.digest(session), string(body, "vehicleId", ID_LENGTH),
            string(body, "token", TOKEN_LENGTH, false), string(body, "deviceId", ID_LENGTH, false))
        return mapOf("registered" to true)
    }

    @DeleteMapping("/push-token")
    fun unregister(@PathVariable date: String, request: HttpServletRequest): Map<String, Boolean> {
        val body = mutation(request, setOf("token"))
        store.unregister(date, username(request), string(body, "token", TOKEN_LENGTH, false))
        return mapOf("unregistered" to true)
    }

    @GetMapping("/messages")
    fun messages(@PathVariable date: String, @RequestParam vehicleId: String, request: HttpServletRequest): ObjectNode {
        limit(username(request), false)
        return store.messages(date, checked(vehicleId, ID_LENGTH))
    }

    @PostMapping("/messages")
    fun message(@PathVariable date: String, request: HttpServletRequest): ObjectNode {
        val body = mutation(request, setOf("vehicleId", "from", "body"))
        val from = string(body, "from", PLATFORM_LENGTH)
        if (from !in setOf("ops", "driver")) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_MESSAGE_FROM")
        val vehicleId = string(body, "vehicleId", ID_LENGTH)
        val pending = store.append(date, vehicleId, from, string(body, "body", MESSAGE_LENGTH))
        // Persist first. Push acceptance does not mean that the device displayed the notification.
        val delivery = if (from == "driver") PushSummary("not-requested") else
            sender.send(pending.tokens, date, body.path("vehicleId").asString(), pending.message.path("id").asString())
        return driverJson.createObjectNode().apply {
            set("message", pending.message)
            set("push", driverJson.valueToTree(delivery))
        }
    }

    @PostMapping("/events")
    fun event(@PathVariable date: String, request: HttpServletRequest): ResponseEntity<ObjectNode> {
        val body = mutation(request, EVENT_FIELDS, setOf("location"), EVENT_BODY)
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(store.activity.acceptEvent(date, body).body)
    }

    @PostMapping("/locations")
    fun locations(@PathVariable date: String, request: HttpServletRequest): ResponseEntity<ObjectNode> {
        val body = mutation(request, setOf("vehicleId", "samples"), maxBody = LOCATION_BODY)
        val samples = body.path("samples") as? ArrayNode ?: invalidInput()
        if (samples.isEmpty || samples.size() > MAX_SAMPLES_PER_BATCH) invalidInput()
        samples.forEach { checkLocation(it, sample = true) }
        return ResponseEntity.status(HttpStatus.ACCEPTED)
            .body(store.activity.acceptLocations(date, string(body, "vehicleId", ID_LENGTH), samples))
    }

    @PostMapping("/photos", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun upload(
        @PathVariable date: String,
        @RequestParam("file") file: MultipartFile,
        request: HttpServletRequest,
    ): ResponseEntity<ObjectNode> {
        if (request.getHeader("Origin") != origin) driverFail(HttpStatus.FORBIDDEN.value(), "ORIGIN_REQUIRED")
        limit(username(request), true)
        if (file.size > MAX_PHOTO) driverFail(HttpStatus.PAYLOAD_TOO_LARGE.value(), "PHOTO_TOO_LARGE")
        if (file.contentType !in PHOTO_TYPES) {
            driverFail(HttpStatus.UNSUPPORTED_MEDIA_TYPE.value(), "UNSUPPORTED_PHOTO_TYPE")
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(store.activity.savePhoto(date, file.bytes))
    }

    @GetMapping("/photos/{photoId}")
    fun photo(
        @PathVariable date: String,
        @PathVariable photoId: String,
        request: HttpServletRequest,
    ): ResponseEntity<ByteArray> {
        limit(username(request), false)
        val photo = store.activity.readPhoto(date, photoId)
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(photo.contentType)).body(photo.bytes)
    }

    @GetMapping("/route")
    fun route(@PathVariable date: String, @RequestParam vehicleId: String, request: HttpServletRequest): ObjectNode {
        limit(username(request), false)
        return store.queries.route(date, checked(vehicleId, ID_LENGTH))
    }

    /** A proposal only: it changes nothing, so it takes the read limit but, being a POST, still needs the Origin. */
    @PostMapping("/route/suggest")
    fun suggest(@PathVariable date: String, @RequestParam vehicleId: String, request: HttpServletRequest): ObjectNode {
        val body = mutation(request, emptySet(), setOf("lockFirst"), write = false, allowEmpty = true)
        val lockFirst = if (body.has("lockFirst")) string(body, "lockFirst", ID_LENGTH, false) else null
        return store.queries.suggest(date, checked(vehicleId, ID_LENGTH), lockFirst)
    }

    /** The driver's note on a stop, told to the next driver and the operator. Idempotent under `requestId`. */
    @PostMapping("/stops/{stopId}/tip")
    fun tip(@PathVariable date: String, @PathVariable stopId: String, request: HttpServletRequest): ObjectNode {
        val body = mutation(request, setOf("vehicleId", "requestId", "body"))
        if (!body.path("body").isString) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        return store.activity.setTip(
            date, string(body, "vehicleId", ID_LENGTH), checked(stopId, ID_LENGTH),
            string(body, "requestId", REQUEST_ID_LENGTH, false), body.path("body").asString(),
        ).body
    }

    @GetMapping("/stops/{stopId}")
    fun stop(
        @PathVariable date: String,
        @PathVariable stopId: String,
        @RequestParam vehicleId: String,
        request: HttpServletRequest,
    ): ObjectNode {
        limit(username(request), false)
        return store.queries.stop(date, checked(vehicleId, ID_LENGTH), checked(stopId, ID_LENGTH))
    }

    @GetMapping("/history")
    fun history(@PathVariable date: String, @RequestParam vehicleId: String, request: HttpServletRequest): ObjectNode {
        limit(username(request), false)
        return store.queries.history(date, checked(vehicleId, ID_LENGTH))
    }

    @GetMapping("/events/{eventId}")
    fun eventResult(
        @PathVariable date: String,
        @PathVariable eventId: String,
        request: HttpServletRequest,
    ): ObjectNode {
        limit(username(request), false)
        return store.activity.eventResult(date, eventId)
    }

    private fun mutation(
        request: HttpServletRequest,
        fields: Set<String>,
        optional: Set<String> = emptySet(),
        maxBody: Int = MAX_BODY,
        write: Boolean = true,
        allowEmpty: Boolean = false,
    ): ObjectNode {
        if (request.getHeader("Origin") != origin) driverFail(HttpStatus.FORBIDDEN.value(), "ORIGIN_REQUIRED")
        limit(username(request), write)
        val bytes = request.inputStream.readNBytes(maxBody + 1)
        if (allowEmpty && bytes.isEmpty()) return driverJson.createObjectNode()
        if (request.contentType?.substringBefore(';')?.trim()?.lowercase() != "application/json") {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_JSON")
        }
        if (bytes.size > maxBody) driverFail(HttpStatus.PAYLOAD_TOO_LARGE.value(), "DRIVER_BODY_TOO_LARGE")
        val body = runCatching { driverJson.readTree(bytes) as? ObjectNode }.getOrNull()
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_JSON")
        val names = body.properties().map { it.key }.toSet()
        if (!names.containsAll(fields) || !(fields + optional).containsAll(names)) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        }
        return body
    }

    private fun username(request: HttpServletRequest): String =
        request.getAttribute("meatbox.username") as? String
            ?: driverFail(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")

    private fun string(body: ObjectNode, key: String, max: Int, allowSpace: Boolean = true): String {
        if (!body.path(key).isString) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        return checked(body.path(key).asString(), max, allowSpace)
    }

    private fun checked(value: String, max: Int, allowSpace: Boolean = true): String =
        driverText(value, max, allowSpace)

    @Synchronized
    private fun limit(username: String, write: Boolean) {
        val now = System.currentTimeMillis()
        limits.entries.removeIf { it.value.until <= now }
        val key = "$username:$write"
        if (key !in limits && limits.size >= MAX_USERS) {
            driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), "DRIVER_CAPACITY")
        }
        val window = limits.getOrPut(key) { Window(now + MINUTE_MILLIS) }
        val maximum = if (write) MAX_WRITES else MAX_READS
        if (++window.count > maximum) driverFail(HttpStatus.TOO_MANY_REQUESTS.value(), "DRIVER_RATE_LIMITED")
    }

    private data class Window(val until: Long, var count: Int = 0)

    companion object {
        private const val MAX_BODY = 8192
        private const val EVENT_BODY = 16 * 1024
        private const val LOCATION_BODY = 64 * 1024
        private const val MAX_SAMPLES_PER_BATCH = 200
        private const val MAX_PHOTO = 5 * 1024 * 1024
        private val PHOTO_TYPES = setOf("image/jpeg", "image/png")
        private val EVENT_FIELDS = setOf("eventId", "type", "occurredAt", "date", "vehicleId", "payload")
        private const val ID_LENGTH = 128
        private const val REQUEST_ID_LENGTH = 64
        private const val TOKEN_LENGTH = 4096
        private const val MESSAGE_LENGTH = 1000
        private const val PLATFORM_LENGTH = 16
        private const val MAX_USERS = 4096
        private const val MAX_WRITES = 30
        private const val MAX_READS = 120
        private const val MINUTE_MILLIS = 60_000L
    }
}
