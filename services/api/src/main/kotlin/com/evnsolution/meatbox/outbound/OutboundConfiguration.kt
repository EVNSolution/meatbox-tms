package com.evnsolution.meatbox.outbound

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.ops.ErrorAlerts
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class OutboundConfiguration {
    @Bean
    fun meatboxClient(
        @Value("\${meatbox.outbound.base-url:}") baseUrl: String,
        @Value("\${meatbox.outbound.token:}") token: String,
    ): MeatboxClient = MeatboxClient(baseUrl, token)

    @Bean
    fun outboxDispatcher(
        store: DispatchStore,
        client: MeatboxClient,
        alerts: ErrorAlerts,
        @Value("\${meatbox.outbound.interval-seconds:5}") intervalSeconds: Long,
    ): OutboxDispatcher = OutboxDispatcher(store, client, alerts).also { it.start(intervalSeconds.coerceAtLeast(1)) }
}
