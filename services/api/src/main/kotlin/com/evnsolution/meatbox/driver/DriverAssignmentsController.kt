package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.auth.DriverAccount
import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.node.ObjectNode

/** The operator's view and edit of which driver account drives which vehicle. Operators only (see `RoleFilter`). */
@RestController
@RequestMapping("/api/ops/driver-assignments")
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverAssignmentsController(
    private val assignments: DriverAssignments,
    private val auth: ObjectProvider<AuthService>,
    @param:Value("\${meatbox.dispatch.public-origin:}") private val origin: String,
) {
    @GetMapping
    fun list(): ObjectNode {
        val view = assignments.view()
        val accounts = drivers().associateBy { it.username }
        return driverJson.createObjectNode().apply {
            put("revision", view.revision)
            putArray("assignments").also { rows ->
                view.assignments.toSortedMap().forEach { (vehicle, driver) ->
                    rows.addObject().put("vehicleId", vehicle).put("driver", driver)
                        .put("known", accounts[driver]?.disabled == false)
                }
            }
            putArray("drivers").also { rows ->
                accounts.values.sortedBy { it.username }.forEach {
                    rows.addObject().put("username", it.username).put("displayName", it.displayName)
                        .put("disabled", it.disabled)
                }
            }
        }
    }

    /** Body `{revision, driver}`; a null `driver` takes the vehicle's driver away. */
    @PutMapping("/{vehicleId}")
    fun assign(@PathVariable vehicleId: String, request: HttpServletRequest): ObjectNode {
        if (origin.isEmpty() || request.getHeader("Origin") != origin) {
            driverFail(HttpStatus.FORBIDDEN.value(), "ORIGIN_REQUIRED")
        }
        val vehicle = driverText(vehicleId, ID_LENGTH, false)
        val (revision, driver) = parse(request)
        if (driver != null && drivers().none { it.username == driver && !it.disabled }) {
            driverFail(HttpStatus.BAD_REQUEST.value(), "DRIVER_NOT_FOUND")
        }
        val view = assignments.assign(revision, vehicle, driver)
        log.info(
            "Changed driver assignment: vehicle={} driver={} revision={} by={}",
            vehicle, driver ?: "-", view.revision, request.getAttribute("meatbox.ops.user") ?: "unknown",
        )
        return driverJson.createObjectNode().put("revision", view.revision).put("vehicleId", vehicle).apply {
            if (driver == null) putNull("driver") else put("driver", driver)
        }
    }

    private fun parse(request: HttpServletRequest): Pair<Long, String?> {
        val body = runCatching { driverJson.readTree(request.inputStream.readNBytes(MAX_BODY + 1)) as? ObjectNode }
            .getOrNull()?.takeIf { it.size() == 2 && it.has("revision") && it.has("driver") }
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        val revision = body.path("revision").takeIf { it.isIntegralNumber && it.asLong() >= 0 }?.asLong()
            ?: driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        val driver = body.path("driver")
        if (!driver.isNull && !driver.isString) driverFail(HttpStatus.BAD_REQUEST.value(), "INVALID_INPUT")
        return revision to driver.takeIf { it.isString }?.asString()
    }

    private fun drivers(): List<DriverAccount> = auth.ifAvailable?.driverAccounts().orEmpty()

    private companion object {
        val log = LoggerFactory.getLogger(DriverAssignmentsController::class.java)
        const val ID_LENGTH = 128
        const val MAX_BODY = 1024
    }
}
