package com.evnsolution.meatbox.integrations.meatbox.inbound

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Path

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class InboundConfiguration {
    /** Always on with dispatch: orders already received stay visible even while the endpoint has no token. */
    @Bean
    fun inboundOrders(
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
        @Value("\${meatbox.inbound.group-count:8}") groupCount: Int,
    ): InboundOrders {
        require(stateDirectory.isNotBlank()) { "Explicit absolute dispatch state directory required" }
        require(groupCount in 1..MAX_GROUPS) { "meatbox.inbound.group-count must be between 1 and $MAX_GROUPS" }
        return InboundOrders(Path.of(stateDirectory).resolve("inbound"), groupCount)
    }

    private companion object { const val MAX_GROUPS = 50 }
}
