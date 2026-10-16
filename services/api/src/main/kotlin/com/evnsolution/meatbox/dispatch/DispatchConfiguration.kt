package com.evnsolution.meatbox.dispatch

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.legacy.LegacySettings
import com.evnsolution.meatbox.integrations.meatbox.inbound.InboundOrders
import com.evnsolution.meatbox.ops.ErrorAlerts
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
        settings: LegacySettings,
        @Value("\${meatbox.dispatch.state-dir:}") directory: String,
        inbound: ObjectProvider<InboundOrders>,
        alerts: ObjectProvider<ErrorAlerts>,
    ): DispatchStore {
        val path = Path.of(directory)
        require(directory.isNotBlank() && path.isAbsolute && path.normalize() == path) {
            "Explicit absolute dispatch state directory required"
        }
        val orders = inbound.ifAvailable
        return DispatchStore(DispatchDataReader(settings, orders), path, inbound = orders).also { store ->
            alerts.ifAvailable?.let { sink ->
                store.onSourceConflict = { date, conflict ->
                    sink.report("dispatch", "SOURCE_CHANGED", "date=$date reason=${conflict.reason}")
                }
            }
        }
    }

    @Bean
    fun dispatchSessionFilter(verifier: SessionVerifier): DispatchSessionFilter = DispatchSessionFilter(verifier)

}
