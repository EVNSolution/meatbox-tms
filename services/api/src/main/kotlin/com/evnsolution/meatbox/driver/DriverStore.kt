package com.evnsolution.meatbox.driver

import org.springframework.http.HttpStatus

import com.evnsolution.meatbox.dispatch.DispatchException
import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaModel
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.RoutePlanner
import tools.jackson.core.StreamReadFeature
import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

internal val driverJson: JsonMapper = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build()
internal fun driverFail(status: Int, code: String): Nothing = throw DispatchException(status, code, code)

/** Text rules shared by every driver input: no blank, no edge or control characters, bounded length. */
internal fun driverText(value: String, max: Int, allowSpace: Boolean = true): String {
    val invalidLength = value.isBlank() || value.length > max
    val invalidSpace = value != value.trim() || (!allowSpace && value.any(Char::isWhitespace))
    val invalidControl = value.any { it.isISOControl() && it != '\n' }
    if (invalidLength || invalidSpace || invalidControl) invalidInput()
    return value
}

/** Demo access follows the existing TMS session; vehicle selection is not a driver identity. */
@Suppress("TooManyFunctions")
class DriverStore(
    internal val dispatch: DispatchStore,
    internal val directory: Path,
    internal val clock: () -> Instant = Instant::now,
    private val isSessionActive: (String, String) -> Boolean,
    internal val publicOrigin: String = "",
    etaConfig: EtaConfig = EtaConfig(),
    /** Where routes start before departure (`meatbox.route.depot-lat/lng`), or null when the installation sets none. */
    internal val depot: EtaPoint? = null,
) {
    internal val eta = EtaModel(etaConfig)
    internal val planner = RoutePlanner(eta.estimator)

    private val fileLock = DriverFileLock(directory.resolve(".driver-state.lock"))

    /** Events, locations and photos that the driver app sends; they share this store's file, lock and checks. */
    val activity: DriverActivity = DriverActivity(this)

    /** The driver app's reads: route, stop detail and the day's history. */
    val queries: DriverQueries = DriverQueries(this)

    @Synchronized
    fun register(
        date: String, username: String, sessionDigest: String, vehicleId: String, token: String, deviceId: String,
    ) {
        mutate {
            validate(date, vehicleId, writable = true)
            val state = load(date)
            pruneDevices(state)
            if (!DIGEST.matches(sessionDigest) || !isSessionActive(sessionDigest, username)) {
                driverFail(HttpStatus.UNAUTHORIZED.value(), "LOGIN_REQUIRED")
            }
            val devices = state.path("devices") as ArrayNode
            val retained = devices.filterNot {
                it.path("token").asString() == token ||
                    (it.path("username").asString() == username && it.path("deviceId").asString() == deviceId)
            }
            val vehicleCount = retained.count { it.path("vehicleId").asString() == vehicleId }
            if (retained.size >= MAX_DEVICES || vehicleCount >= PER_VEHICLE) {
                driverFail(HttpStatus.CONFLICT.value(), "DRIVER_DEVICE_CAPACITY")
            }
            state.set("devices", driverJson.createArrayNode().apply {
                retained.forEach(::add)
                addObject().put("username", username).put("vehicleId", vehicleId).put("token", token)
                    .put("deviceId", deviceId).put("platform", "android").put("sessionDigest", sessionDigest)
            })
            save(date, state)
        }
    }

    @Synchronized
    fun unregister(date: String, username: String, token: String) {
        mutate {
            validate(date)
            val state = load(date)
            val retained = state.path("devices").filterNot {
                it.path("username").asString() == username && it.path("token").asString() == token
            }
            state.set("devices", driverJson.createArrayNode().apply { retained.forEach(::add) })
            save(date, state)
        }
    }

    @Synchronized
    fun messages(date: String, vehicleId: String): ObjectNode {
        validate(date, vehicleId)
        val messages = load(date).path("messages").filter { it.path("vehicleId").asString() == vehicleId }
        return driverJson.createObjectNode().apply {
            set("messages", driverJson.createArrayNode().apply {
                messages.forEach { add(publicMessage(it as ObjectNode)) }
            })
        }
    }

    @Synchronized
    fun append(date: String, vehicleId: String, from: String, body: String): PendingMessage {
        return mutate {
            validate(date, vehicleId, writable = true)
            val state = load(date)
            pruneDevices(state)
            val messages = state.path("messages") as ArrayNode
            if (messages.size() >= MAX_MESSAGES) driverFail(HttpStatus.CONFLICT.value(), "DRIVER_MESSAGE_CAPACITY")
            val message = driverJson.createObjectNode().put("id", UUID.randomUUID().toString())
                .put("vehicleId", vehicleId).put("from", from).put("body", body).put("createdAt", clock().toString())
            messages.add(message)
            save(date, state)
            val tokens = if (from == "ops") {
                state.path("devices").filter { it.path("vehicleId").asString() == vehicleId }
                    .map { it.path("token").asString() }
            } else emptyList()
            PendingMessage(publicMessage(message), tokens)
        }
    }

    /** The push tokens of the devices signed in for this vehicle and date. Read only; an unreadable day has none. */
    @Synchronized
    fun tokens(date: String, vehicleId: String): List<String> = runCatching {
        load(date).path("devices").filter {
            it.path("vehicleId").asString() == vehicleId &&
                isSessionActive(it.path("sessionDigest").asString(), it.path("username").asString())
        }.map { it.path("token").asString() }
    }.getOrDefault(emptyList())

    private fun pruneDevices(state: ObjectNode) {
        val devices = state.path("devices").filter {
            isSessionActive(it.path("sessionDigest").asString(), it.path("username").asString())
        }
        state.set("devices", driverJson.createArrayNode().apply { devices.forEach(::add) })
    }

    internal fun <T> mutate(action: () -> T): T = try {
        verifyDirectory()
        fileLock.withLock(action)
    } catch (error: DispatchException) {
        throw error
    } catch (error: DispatchDataException) {
        throw error
    } catch (_: Exception) {
        driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), "DRIVER_STATE_WRITE_FAILED")
    }

    internal fun validate(date: String, vehicleId: String? = null, writable: Boolean = false) {
        val parsedDate = runCatching { LocalDate.parse(date).toString() == date }.getOrDefault(false)
        val validDate = DATE.matches(date) && parsedDate
        if (!validDate) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_DATE")
        val state = dispatch.snapshot(date)
        if (writable && state.path("dispatch").path("readOnly").asBoolean(true)) {
            driverFail(HttpStatus.CONFLICT.value(), "DRIVER_DATE_READ_ONLY")
        }
        if (vehicleId != null && state.path("fleetVehicles").none { it.path("id").asString() == vehicleId }) {
            driverFail(HttpStatus.NOT_FOUND.value(), "DRIVER_VEHICLE_NOT_FOUND")
        }
    }

    internal fun load(date: String): ObjectNode = fileOperation("DRIVER_STATE_INVALID") {
        verifyDirectory()
        val file = directory.resolve("driver-$date.json")
        if (!Files.exists(file, NOFOLLOW_LINKS)) return@fileOperation driverJson.createObjectNode().apply {
            put("schemaVersion", SCHEMA_VERSION).put("date", date)
            set("devices", driverJson.createArrayNode())
            set("messages", driverJson.createArrayNode())
            set("events", driverJson.createArrayNode())
            set("locations", driverJson.createObjectNode())
            put("locationVersion", 0)
        }
        check(Files.isRegularFile(file, NOFOLLOW_LINKS) && !Files.isSymbolicLink(file))
        check(Files.size(file) <= MAX_FILE_BYTES)
        val node = driverJson.readTree(Files.readAllBytes(file)) as? ObjectNode ?: error("Invalid state")
        check(node.path("schemaVersion").asInt() == SCHEMA_VERSION && node.path("date").asString() == date)
        checkActivity(node)
        check(node.path("devices").isArray && node.path("messages").isArray)
        check(node.path("devices").size() <= MAX_DEVICES && node.path("messages").size() <= MAX_MESSAGES)
        check(node.path("devices").all { device ->
            listOf("username", "vehicleId", "token", "deviceId", "sessionDigest").all { device.path(it).isString } &&
                device.path("platform").asString() == "android" &&
                DIGEST.matches(device.path("sessionDigest").asString())
        })
        check(node.path("messages").all { message ->
            listOf("id", "vehicleId", "from", "body", "createdAt").all { message.path(it).isString } &&
                message.path("from").asString() in setOf("ops", "driver")
        })
        node
    }

    internal fun save(date: String, state: ObjectNode) = fileOperation("DRIVER_STATE_WRITE_FAILED") {
        verifyDirectory()
        val file = directory.resolve("driver-$date.json")
        check(!Files.exists(file, NOFOLLOW_LINKS) || Files.isRegularFile(file, NOFOLLOW_LINKS))
        check(!Files.isSymbolicLink(file))
        val temporary = directory.resolve(".driver-$date-${UUID.randomUUID()}.tmp")
        try {
            val bytes = driverJson.writeValueAsBytes(state)
            check(bytes.size <= MAX_FILE_BYTES)
            val permissions = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
            val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
            FileChannel.open(temporary, options, permissions).use {
                val buffer = ByteBuffer.wrap(bytes)
                while (buffer.hasRemaining()) it.write(buffer)
                it.force(true)
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            runCatching { Files.deleteIfExists(temporary) }
        }
    }

    private fun verifyDirectory() {
        check(directory.isAbsolute && directory.normalize() == directory)
        check(Files.isDirectory(directory, NOFOLLOW_LINKS))
        var cursor: Path? = directory
        while (cursor != null) {
            check(!Files.isSymbolicLink(cursor))
            cursor = cursor.parent
        }
    }

    private fun <T> fileOperation(code: String, operation: () -> T): T = try {
        operation()
    } catch (_: Exception) {
        driverFail(HttpStatus.SERVICE_UNAVAILABLE.value(), code)
    }


    data class PendingMessage(val message: ObjectNode, val tokens: List<String>)

    companion object {
        private const val SCHEMA_VERSION = 2
        private val DIGEST = Regex("[a-f0-9]{64}")
        private val DATE = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        private const val MAX_DEVICES = 1000
        private const val PER_VEHICLE = 3
        private const val MAX_MESSAGES = 2000
        internal const val MAX_EVENTS = 3000
        internal const val MAX_FILE_BYTES = 8 * 1024 * 1024
    }
}

private fun publicMessage(message: ObjectNode): ObjectNode = driverJson.createObjectNode().apply {
    listOf("id", "from", "body", "createdAt").forEach { put(it, message.path(it).asString()) }
}

// Files written before events and locations existed stay valid; the new parts start empty.
private fun checkActivity(node: ObjectNode) {
    if (!node.has("events")) node.set("events", driverJson.createArrayNode())
    if (!node.has("locations")) node.set("locations", driverJson.createObjectNode())
    if (!node.has("locationVersion")) node.put("locationVersion", 0)
    val events = node.path("events")
    check(events.isArray && node.path("locations").isObject && node.path("locationVersion").isIntegralNumber)
    check(events.size() <= DriverStore.MAX_EVENTS && node.path("locations").properties().all { it.value.isArray })
    check(events.all { event -> listOf("eventId", "type", "vehicleId").all { event.path(it).isString } })
}
