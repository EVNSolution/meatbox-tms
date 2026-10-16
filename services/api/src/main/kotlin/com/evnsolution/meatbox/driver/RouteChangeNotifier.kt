package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.RouteChange
import com.evnsolution.meatbox.dispatch.RouteChangeListener
import com.evnsolution.meatbox.integrations.fcm.PushContent
import com.evnsolution.meatbox.integrations.fcm.PushSummary
import org.slf4j.LoggerFactory
import java.util.concurrent.Executor

/**
 * Tells a driver's phone that an operator changed the vehicle's route (confirmation, amendment, reassignment, new
 * order). The dispatch store calls [changed] while it holds its lock, so this only hands the work to [executor];
 * reading the device tokens and the network call to FCM happen there, never under the dispatch lock. A failed or
 * unconfigured push is only logged: the app reads the route again whenever it comes to the foreground.
 */
class RouteChangeNotifier(
    private val store: DriverStore,
    private val send: (tokens: List<String>, date: String, vehicleId: String, content: PushContent) -> PushSummary,
    private val executor: Executor = Executor { task ->
        Thread(task, "route-change-push").apply { isDaemon = true }.start()
    },
) : RouteChangeListener {
    override fun changed(date: String, revision: Long, changes: List<RouteChange>) {
        changes.forEach { change -> executor.execute { notify(date, revision, change) } }
    }

    private fun notify(date: String, revision: Long, change: RouteChange) {
        runCatching {
            val tokens = store.tokens(date, change.vehicleId)
            val summary = send(tokens, date, change.vehicleId,
                PushContent("route_changed", "미트박스 배송", change.describe(), "route-$revision"))
            log.info("route change push for {} on {}: {}", change.vehicleId, date, summary.status)
        }.onFailure { log.warn("route change push for {} on {} failed", change.vehicleId, date, it) }
    }

    private companion object {
        val log = LoggerFactory.getLogger(RouteChangeNotifier::class.java)
    }
}
