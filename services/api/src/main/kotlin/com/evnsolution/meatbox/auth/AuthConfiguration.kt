package com.evnsolution.meatbox.auth

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.auth", name = ["enabled"], havingValue = "true")
class AuthConfiguration {
    @Bean
    fun authSettings(properties: AuthProperties): AuthSettings = properties.settings()

    @Bean
    fun authService(settings: AuthSettings): AuthService = AuthService(settings)
}
