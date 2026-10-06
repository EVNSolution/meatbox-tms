package com.evnsolution.meatbox.compat

import com.evnsolution.meatbox.auth.SessionVerifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.net.http.HttpClient
import java.time.Duration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.compat", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(CompatProperties::class)
class CompatConfiguration {
    @Bean
    fun compatSettings(properties: CompatProperties): CompatSettings = properties.settings()

    @Bean
    fun legacySessionHttpClient(): HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(1))
        .followRedirects(HttpClient.Redirect.NEVER)
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    @Bean
    @ConditionalOnProperty(prefix = "meatbox.auth", name = ["enabled"], havingValue = "false", matchIfMissing = true)
    fun legacySessionVerifier(client: HttpClient, settings: CompatSettings): SessionVerifier =
        LegacySessionVerifier(client, settings.legacyApiOrigin)
}
