package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchStore
import com.evnsolution.meatbox.resources.ResourceSettings
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.info.BuildProperties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Path
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

private const val PURGE_HOURS = 6L

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "meatbox.dispatch", name = ["enabled"], havingValue = "true")
class ExportConfiguration {
    @Bean
    fun exportWriter(
        dispatch: DispatchStore,
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
        resources: ObjectProvider<ResourceSettings>,
        build: ObjectProvider<BuildProperties>,
    ): ExportWriter {
        val state = Path.of(stateDirectory)
        require(stateDirectory.isNotBlank() && state.isAbsolute) {
            "Explicit absolute dispatch state directory required"
        }
        val sources = ExportSources(state, resources.ifAvailable?.database, dispatch::sourceDay) { date ->
            dispatch.snapshot(date)
        }
        val info = build.ifAvailable
        return ExportWriter(sources, info?.version ?: "unknown", info?.get("commit") ?: "unknown")
    }

    // Declared as the interface: ErrorAlerts injects the one ScheduledThreadPoolExecutor bean by class.
    @Bean(destroyMethod = "shutdown")
    fun exportExecutor(): ScheduledExecutorService = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "meatbox-export").apply { isDaemon = true }
    }

    @Bean
    fun exportJobs(
        writer: ExportWriter,
        @Qualifier("exportExecutor") executor: ScheduledExecutorService,
        @Value("\${meatbox.dispatch.state-dir:}") stateDirectory: String,
    ): ExportJobs = ExportJobs(Path.of(stateDirectory).resolve("exports"), writer, executor).also { jobs ->
        executor.scheduleWithFixedDelay({ jobs.purge() }, PURGE_HOURS, PURGE_HOURS, TimeUnit.HOURS)
    }

    @Bean
    fun exportController(jobs: ObjectProvider<ExportJobs>): ExportController = ExportController(jobs)

    @Bean
    fun exportRunner(
        writer: ExportWriter,
        @Value("\${meatbox.export.out:}") out: String,
        @Value("\${meatbox.export.from:}") from: String,
        @Value("\${meatbox.export.to:}") to: String,
        @Value("\${meatbox.export.include:}") include: String,
        @Value("\${spring.main.web-application-type:}") webApplicationType: String,
    ): ExportRunner = ExportRunner(writer, out, from, to, include, webApplicationType)
}
