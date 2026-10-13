package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.compat.CompatSettings
import com.evnsolution.meatbox.compat.DispatchDataReader
import com.evnsolution.meatbox.dispatch.DispatchStore
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

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
