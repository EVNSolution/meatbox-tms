package com.evnsolution.meatbox.legacy

import com.evnsolution.meatbox.auth.SessionVerifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.net.http.HttpClient
import java.time.Duration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.compat", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(LegacyProperties::class)
class LegacyConfiguration {
    @Bean
    fun compatSettings(properties: LegacyProperties): LegacySettings = properties.settings()

    @Bean
    fun legacySessionHttpClient(): HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(1))
        .followRedirects(HttpClient.Redirect.NEVER)
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    @Bean
    @ConditionalOnProperty(prefix = "meatbox.auth", name = ["enabled"], havingValue = "false", matchIfMissing = true)
    fun legacySessionVerifier(client: HttpClient, settings: LegacySettings): SessionVerifier =
        LegacySessionVerifier(client, settings.legacyApiOrigin)
}
