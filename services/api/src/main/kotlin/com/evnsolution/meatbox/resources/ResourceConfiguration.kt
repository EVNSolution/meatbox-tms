package com.evnsolution.meatbox.resources

import com.evnsolution.meatbox.auth.SessionVerifier
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.resources", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(ResourceProperties::class)
class ResourceConfiguration {
    @Bean
    fun resourceSettings(
        properties: ResourceProperties,
        @Value("\${meatbox.compat.enabled:false}") compatEnabled: Boolean,
    ): ResourceSettings = properties.settings(compatEnabled)

    @Bean
    fun resourceStore(settings: ResourceSettings): ResourceStore = ResourceStore(settings.database)

    @Bean
    fun resourceSessionFilter(
        verifierProvider: ObjectProvider<SessionVerifier>,
        settings: ResourceSettings,
    ): ResourceSessionFilter = ResourceSessionFilter(
        requireNotNull(verifierProvider.ifAvailable) {
            "meatbox.resources.enabled requires a session verifier"
        },
        settings,
    )
}
