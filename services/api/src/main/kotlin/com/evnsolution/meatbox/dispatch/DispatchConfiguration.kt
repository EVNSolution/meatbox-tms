package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.compat.DispatchDataReader
import com.evnsolution.meatbox.compat.CompatSettings
import com.evnsolution.meatbox.inbound.InboundOrders
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Path

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class DispatchConfiguration {
    @Bean
    fun dispatchStore(
        settings: CompatSettings,
        @Value("\${meatbox.dispatch.state-dir:}") directory: String,
        inbound: ObjectProvider<InboundOrders>,
    ): DispatchStore {
        val path = Path.of(directory)
        require(directory.isNotBlank() && path.isAbsolute && path.normalize() == path) {
            "Explicit absolute dispatch state directory required"
        }
        val orders = inbound.ifAvailable
        return DispatchStore(DispatchDataReader(settings, orders), path, inbound = orders)
    }

    @Bean
    fun dispatchSessionFilter(verifier: SessionVerifier): DispatchSessionFilter = DispatchSessionFilter(verifier)

}
