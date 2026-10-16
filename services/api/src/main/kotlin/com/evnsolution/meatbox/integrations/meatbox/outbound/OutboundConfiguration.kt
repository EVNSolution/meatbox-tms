package com.evnsolution.meatbox.integrations.meatbox.outbound

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.ops.ErrorAlerts
import com.evnsolution.meatbox.telemetry.TemperatureOutbox
import org.springframework.beans.factory.ObjectProvider
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
        telemetryOutbox: ObjectProvider<TemperatureOutbox>,
        @Value("\${meatbox.outbound.interval-seconds:5}") intervalSeconds: Long,
    ): OutboxSender = OutboxSender(store, client, alerts, telemetryOutbox = telemetryOutbox.ifAvailable).also {
        it.start(intervalSeconds.coerceAtLeast(1))
    }
}
