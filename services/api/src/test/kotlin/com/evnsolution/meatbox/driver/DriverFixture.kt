package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.compat.CompatSettings
import com.evnsolution.meatbox.compat.DispatchDataReader
import com.evnsolution.meatbox.dispatch.DispatchStore
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import tools.jackson.databind.node.ObjectNode

internal const val DRIVER_DATE = "2026-10-13"

internal val DRIVER_DIGEST = "a".repeat(64)

internal fun driverFixture(
    directory: Path,
    today: String = DRIVER_DATE,
    isSessionActive: (String, String) -> Boolean = { _, _ -> true },
): Pair<DriverStore, Path> {
    val root = directory.toRealPath()
    Files.createDirectories(root.resolve("data/days"))
    Files.createDirectories(root.resolve("state"))
    Files.writeString(root.resolve("data/manifest.json"), """
        {"schemaVersion":1,"defaultDate":"$DRIVER_DATE","dates":[{"date":"$DRIVER_DATE"}],"source":{"csvSha256":"fixture"}}
    """.trimIndent())
    Files.writeString(root.resolve("data/days/$DRIVER_DATE.json"), """
        {"schemaVersion":1,"date":"$DRIVER_DATE","summary":{"orders":1,"boxes":1},
         "groups":[{"id":"G1","label":"합성 기사","regionNames":["합성 권역"]}],
         "orders":[{"id":"O1","groupId":"G1","name":"합성 배송지","address":"합성 주소",
         "boxes":1,"sourceRows":1,"sequence":1,"coordinates":[127.0,37.5],"zoneIds":["Z1"]}]}
    """.trimIndent())
    val reader = DispatchDataReader(CompatSettings(URI("http://127.0.0.1:1"), root.resolve("data")))
    val dispatch = DispatchStore(reader, root.resolve("state")) { Instant.parse("${today}T01:00:00Z").toEpochMilli() }
    return DriverStore(dispatch, root.resolve("state"), isSessionActive = isSessionActive) to root.resolve("state")
}

/** Three stops for one vehicle: O1+O2 share a destination, then O3 and O4. The date is published and writable. */
internal class RouteFixture(
    val driver: DriverStore,
    val dispatch: DispatchStore,
    val state: Path,
    val now: AtomicLong,
) {
    /** A second pair over the same state directory, as after a service restart. */
    fun restarted(): RouteFixture = RouteFixture.open(state.parent, now)

    companion object {
        fun open(root: Path, now: AtomicLong): RouteFixture {
            val reader = DispatchDataReader(CompatSettings(URI("http://127.0.0.1:1"), root.resolve("data")))
            val dispatch = DispatchStore(reader, root.resolve("state"), now::get)
            val clock = { Instant.ofEpochMilli(now.get()) }
            val driver = DriverStore(dispatch, root.resolve("state"), clock, { _, _ -> true })
            return RouteFixture(driver, dispatch, root.resolve("state"), now)
        }
    }
}

internal fun routeFixture(directory: Path): RouteFixture {
    val root = directory.toRealPath()
    Files.createDirectories(root.resolve("data/days"))
    Files.createDirectories(root.resolve("state"))
    Files.writeString(root.resolve("data/manifest.json"), """
        {"schemaVersion":1,"defaultDate":"$DRIVER_DATE","dates":[{"date":"$DRIVER_DATE"}],"source":{"csvSha256":"fixture"}}
    """.trimIndent())
    fun order(id: String, name: String, sequence: Int) =
        """{"id":"$id","groupId":"G1","name":"$name","address":"$name 주소","boxes":1,"sourceRows":1,
        "sequence":$sequence,"coordinates":[127.0,37.5],"zoneIds":["Z1"]}"""
    Files.writeString(root.resolve("data/days/$DRIVER_DATE.json"), """
        {"schemaVersion":1,"date":"$DRIVER_DATE","summary":{"orders":4,"boxes":4},
         "groups":[{"id":"G1","label":"합성 기사","regionNames":["합성 권역"]}],
         "orders":[${order("O1", "가게A", 1)},${order("O2", "가게A", 2)},${order("O3", "가게B", 3)},${order("O4", "가게C", 4)}]}
    """.trimIndent())
    val fixture = RouteFixture.open(root, AtomicLong(Instant.parse("${DRIVER_DATE}T01:00:00Z").toEpochMilli()))
    fun run(command: ObjectNode) =
        fixture.dispatch.command(DRIVER_DATE, command.put("expectedBoot", fixture.dispatch.boot))
    run(driverJson.createObjectNode().put("type", "calculate_dispatch").put("expectedRevision", 0)
        .set("vehicleIds", driverJson.createArrayNode().add("G1")))
    run(driverJson.createObjectNode().put("type", "publish_dispatch").put("expectedRevision", 1).put("draftVersion", 1))
    return fixture
}
