package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.auth.AuthService
import com.evnsolution.meatbox.eta.EtaConfig
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
    ): DriverStore = DriverStore(dispatch, Path.of(directory), isSessionActive = { digest, username ->
        auth.ifAvailable?.isSessionActive(digest, username) == true
    }, publicOrigin = origin, etaConfig = EtaConfig(detourFactor, speedKmh, serviceMinutes))

    @Bean
    fun fcmSender(
        @Value("\${MEATBOX_FCM_SERVICE_ACCOUNT_FILE:}") accountFile: String,
        @Value("\${MEATBOX_FCM_PROJECT_ID:}") projectId: String,
    ): FcmSender = FcmSender(accountFile, projectId)
}
