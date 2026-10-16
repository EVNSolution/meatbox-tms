package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.eta.EtaConfig
import com.evnsolution.meatbox.eta.EtaPoint
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
        @Value("\${meatbox.dispatch.state-dir:}") directory: String,
        @Value("\${meatbox.dispatch.public-origin:}") origin: String,
        @Value("\${meatbox.eta.detour-factor:1.4}") detourFactor: Double,
        @Value("\${meatbox.eta.speed-kmh:25}") speedKmh: Double,
        @Value("\${meatbox.eta.service-minutes:5}") serviceMinutes: Int,
        @Value("\${meatbox.eta.delay-threshold-minutes:10}") delayThresholdMinutes: Int,
        @Value("\${meatbox.route.depot-lat:}") depotLat: String,
        @Value("\${meatbox.route.depot-lng:}") depotLng: String,
    ): DriverStore = DriverStore(dispatch, Path.of(directory), isSessionActive = { digest, username ->
        auth.ifAvailable?.isSessionActive(digest, username) == true
    }, publicOrigin = origin, etaConfig = EtaConfig(detourFactor, speedKmh, serviceMinutes, delayThresholdMinutes),
        depot = depot(depotLat, depotLng))

    /** Wires operator route changes to the drivers' phones. */
    @Bean
    fun routeChangeNotifier(dispatch: DispatchStore, store: DriverStore, sender: FcmSender): RouteChangeNotifier =
        RouteChangeNotifier(store, send = { tokens, date, vehicleId, content ->
            sender.send(tokens, date, vehicleId, content)
        })
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
