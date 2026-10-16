package com.evnsolution.meatbox.telemetry

import com.evnsolution.meatbox.auth.SessionVerifier
import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.dispatch.TemperatureSource
import com.evnsolution.meatbox.integrations.meatbox.inbound.MeatboxInboundFilter
import com.evnsolution.meatbox.integrations.meatbox.outbound.MeatboxClient
import com.evnsolution.meatbox.ops.ErrorAlerts
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
    fun temperatureWatch(
        store: TemperatureStore,
        alerts: ErrorAlerts,
        dispatch: DispatchStore,
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
        @Value("\${meatbox.telemetry.default-kind:}") defaultKind: String,
    ): TemperatureWatch {
        require(defaultKind.isEmpty() || defaultKind in setOf("frozen", "chilled")) {
            "meatbox.telemetry.default-kind must be empty, frozen or chilled"
        }
        val file = Path.of(stateDirectory).resolve("telemetry/ranges.json")
        val ranges = TemperatureRanges(file, defaultKind.ifEmpty { null }) {
            alerts.report("telemetry", "RANGES_INVALID")
        }
        return TemperatureWatch(store, ranges, alerts).also {
            dispatch.temperatures = TemperatureSource(it::perVehicle)
        }
    }

    @Bean
    fun temperatureOutbox(
        store: TemperatureStore,
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
    ): TemperatureOutbox = TemperatureOutbox(store, Path.of(stateDirectory).resolve("telemetry"))

    /** Batches only while a Meatbox address is set; without one the measurements simply wait in their day files. */
    @Bean(destroyMethod = "close")
    fun temperatureBatcher(
        outbox: TemperatureOutbox,
        client: MeatboxClient,
        alerts: ErrorAlerts,
        @Value("\${meatbox.telemetry.batch-seconds:60}") batchSeconds: Long,
    ): TemperatureBatcher = TemperatureBatcher(outbox, alerts).also {
        if (client.enabled) it.start(batchSeconds.coerceAtLeast(1))
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
