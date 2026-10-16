package com.evnsolution.meatbox.integrations.meatbox.inbound

import com.evnsolution.meatbox.legacy.LegacySettings
import com.evnsolution.meatbox.legacy.DispatchDataException
import com.evnsolution.meatbox.legacy.DispatchDataReader
import com.evnsolution.meatbox.dispatch.dispatchMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

class InboundDaysReaderTest {
    @TempDir lateinit var temp: Path

    @Test
    fun `lists pushed dates in the manifest, serves their day, and leaves a manifest without them untouched`() {
        val root = temp.toRealPath()
        Files.createDirectories(root.resolve("data/days"))
        val manifest =
            """{"schemaVersion":1,"defaultDate":"2026-10-13","dates":[{"date":"2026-10-13","weekday":"화"}]}"""
        Files.writeString(root.resolve("data/manifest.json"), manifest)
        Files.writeString(root.resolve("data/days/2026-10-13.json"), """{"date":"2026-10-13","orders":[]}""")
        val now = Instant.parse("2026-10-13T01:00:00Z").toEpochMilli()
        val inbound = InboundOrders(root.resolve("state/inbound"), 2) { now }
        val reader = DispatchDataReader(LegacySettings(URI("http://127.0.0.1:1"), root.resolve("data")), inbound)

        assertThat(String(reader.manifest(null).bytes)).isEqualTo(manifest)
        assertThatThrownBy { reader.day(INBOUND_DATE, null) }.isInstanceOf(DispatchDataException::class.java)

        inbound.plan(order("A", boxes = 3), "unplanned", emptySet()).file!!.let(inbound::write)
        inbound.plan(order("B", boxes = 2), "unplanned", emptySet()).file!!.let(inbound::write)

        val listed = dispatchMapper.readTree(reader.manifest(null).bytes)
        assertThat(listed.path("dates").toList().map { it.path("date").asString() })
            .containsExactly("2026-10-13", INBOUND_DATE)
        assertThat(listed.path("dates")[0].path("weekday").asString()).isEqualTo("화")
        assertThat(listed.path("dates")[1].path("source").asString()).isEqualTo("api")
        assertThat(listed.path("dates")[1].path("weekday").asString()).isEqualTo("수요일")
        assertThat(listed.path("dates")[1].path("orders").asInt()).isEqualTo(2)
        assertThat(listed.path("dates")[1].path("boxes").asInt()).isEqualTo(5)
        assertThat(listed.path("defaultDate").asString()).isEqualTo("2026-10-13")

        val day = dispatchMapper.readTree(reader.day(INBOUND_DATE, null).bytes)
        assertThat(day.path("date").asString()).isEqualTo(INBOUND_DATE)
        assertThat(day.path("orders").size()).isEqualTo(2)
        assertThat(day.path("groups").size()).isEqualTo(2)
        assertThat(reader.day(INBOUND_DATE, "gzip").contentEncoding).isEqualTo("gzip")
    }
}
