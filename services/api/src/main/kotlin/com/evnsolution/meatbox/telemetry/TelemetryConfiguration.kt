package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.integrations.meatbox.inbound.MeatboxInboundFilter
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Path
import java.time.Duration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class TelemetryConfiguration {
    @Bean
    fun temperatureStore(
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
        @Value("\${meatbox.telemetry.stale-minutes:10}") staleMinutes: Long,
    ): TemperatureStore {
        require(stateDirectory.isNotBlank()) { "Explicit absolute dispatch state directory required" }
        require(staleMinutes in 1..MAX_STALE_MINUTES) { "meatbox.telemetry.stale-minutes must be between 1 and 1440" }
        val directory = Path.of(stateDirectory).resolve("telemetry")
        return TemperatureStore(directory, staleAfter = Duration.ofMinutes(staleMinutes))
    }

    @Bean
    fun telemetrySessionFilter(verifier: SessionVerifier): TelemetrySessionFilter = TelemetrySessionFilter(verifier)

    private companion object { const val MAX_STALE_MINUTES = 1440L }
}

/** The token check exists only with a token, so a deployment without one has no ingest route (404). */
@Configuration(proxyBeanMethods = false)
@ConditionalOnExpression("'\${meatbox.dispatch.enabled:false}' == 'true' && '\${meatbox.telemetry.token:}' != ''")
class TelemetryIngestConfiguration {
    @Bean
    fun telemetryTokenFilter(@Value("\${meatbox.telemetry.token:}") token: String): MeatboxInboundFilter =
        MeatboxInboundFilter(token, Regex("^/api/telemetry/temperature$"), "TELEMETRY_UNAUTHORIZED")
}
