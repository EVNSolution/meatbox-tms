package com.evnsolution.meatbox.ops

import com.evnsolution.meatbox.auth.SessionVerifier
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.net.InetAddress
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

@Configuration(proxyBeanMethods = false)
class OpsConfiguration {
    @Bean(destroyMethod = "shutdown")
    fun alertExecutor(): ScheduledThreadPoolExecutor = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "meatbox-alerts").apply { isDaemon = true }
    }

    @Bean
    fun errorAlerts(
        executor: ScheduledThreadPoolExecutor,
        @Value("\${meatbox.ops.alert-webhook-url:}") webhookUrl: String,
        @Value("\${meatbox.ops.server-name:}") serverName: String,
    ): ErrorAlerts {
        val channel = if (webhookUrl.isBlank()) LogAlertChannel() else WebhookAlertChannel(webhookUrl)
        val host = serverName.ifBlank { runCatching { InetAddress.getLocalHost().hostName }.getOrDefault("unknown") }
        return ErrorAlerts(channel, host, executor).also {
            executor.scheduleWithFixedDelay(it::flush, FLUSH_SECONDS, FLUSH_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Bean
    fun opsSessionFilter(verifier: ObjectProvider<SessionVerifier>): OpsSessionFilter =
        OpsSessionFilter(verifier)

    private companion object { const val FLUSH_SECONDS = 30L }
}
