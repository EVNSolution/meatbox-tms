package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.auth.Role
import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaPoint
import com.evnsolution.meatbox.eta.HaversineEstimator
import com.evnsolution.meatbox.eta.OsrmTableEstimator
import com.evnsolution.meatbox.eta.VroomOptimizer
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.integrations.fcm.FcmSender
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Path

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DriverConfiguration {
    @Bean
    fun driverStore(
        dispatch: DispatchStore,
        auth: ObjectProvider<AuthService>,
        assignments: DriverAssignments,
        @Value("\${meatbox.dispatch.state-dir:}") directory: String,
        @Value("\${meatbox.dispatch.public-origin:}") origin: String,
        @Value("\${meatbox.eta.detour-factor:1.4}") detourFactor: Double,
        @Value("\${meatbox.eta.speed-kmh:25}") speedKmh: Double,
        @Value("\${meatbox.eta.service-minutes:5}") serviceMinutes: Int,
        @Value("\${meatbox.eta.delay-threshold-minutes:10}") delayThresholdMinutes: Int,
        @Value("\${meatbox.route.depot-lat:}") depotLat: String,
        @Value("\${meatbox.route.depot-lng:}") depotLng: String,
        @Value("\${MEATBOX_OSRM_BASE_URL:}") osrmBaseUrl: String,
        @Value("\${MEATBOX_VROOM_URL:}") vroomUrl: String,
        alerts: ErrorAlerts,
    ): DriverStore {
        val etaConfig = EtaConfig(detourFactor, speedKmh, serviceMinutes, delayThresholdMinutes)
        val road = osrmBaseUrl.trim().takeIf { it.isNotEmpty() }
            ?.let { OsrmTableEstimator(it, HaversineEstimator(etaConfig), alerts) }
        val optimizer = vroomUrl.trim().takeIf { it.isNotEmpty() }?.let { VroomOptimizer(it, alerts) }
        return DriverStore(dispatch, Path.of(directory), isSessionActive = { digest, username ->
            auth.ifAvailable?.isSessionActive(digest, username) == true
        }, mayDrive = { username, vehicleId ->
            // Operators run every vehicle. A driver only the ones that are assigned to them.
            val service = auth.ifAvailable
            service == null || service.roleOf(username) == Role.OPS || assignments.driverOf(vehicleId) == username
        }, publicOrigin = origin, etaConfig = etaConfig, depot = depot(depotLat, depotLng), estimator = road,
            optimizer = optimizer)
    }

    @Bean
    fun driverAssignments(@Value("\${meatbox.dispatch.state-dir:}") directory: String): DriverAssignments =
        DriverAssignments(Path.of(directory).resolve("driver-assignments.json"))

    @Bean
    fun driverProfiles(@Value("\${meatbox.dispatch.state-dir:}") directory: String): DriverProfiles =
        DriverProfiles(Path.of(directory).resolve("driver-profiles.json"))

    @Bean
    fun incentiveRulesFile(@Value("\${meatbox.dispatch.state-dir:}") directory: String): IncentiveRulesFile =
        IncentiveRulesFile(Path.of(directory).resolve("incentive-rules.json"))

    @Bean
    fun dashboard(store: DriverStore, assignments: DriverAssignments, rules: IncentiveRulesFile): Dashboard =
        Dashboard(store, assignments, rules)

    /** Wires operator route changes to the drivers' phones. */
    @Bean
    fun routeChangeNotifier(dispatch: DispatchStore, store: DriverStore, sender: FcmSender): RouteChangeNotifier =
        RouteChangeNotifier(store, send = { tokens, date, vehicleId, content ->
            sender.send(tokens, date, vehicleId, content)
        }, configured = { sender.configured })
            .also { dispatch.routeChanges = it }

    @Bean
    fun fcmSender(
        @Value("\${MEATBOX_FCM_SERVICE_ACCOUNT_FILE:}") accountFile: String,
        @Value("\${MEATBOX_FCM_PROJECT_ID:}") projectId: String,
    ): FcmSender = FcmSender(accountFile, projectId)

    private fun depot(lat: String, lng: String): EtaPoint? {
        if (lat.isBlank() && lng.isBlank()) return null
        val point = EtaPoint(
            lat.trim().toDoubleOrNull() ?: Double.NaN,
            lng.trim().toDoubleOrNull() ?: Double.NaN,
        )
        require(point.lat in -MAX_LAT..MAX_LAT && point.lng in -MAX_LNG..MAX_LNG) {
            "meatbox.route.depot-lat and depot-lng must both be set to valid coordinates"
        }
        return point
    }

    private companion object {
        const val MAX_LAT = 90.0
        const val MAX_LNG = 180.0
    }
}
