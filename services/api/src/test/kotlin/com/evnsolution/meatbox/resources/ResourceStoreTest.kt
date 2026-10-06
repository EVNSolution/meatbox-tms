package com.evnsolution.meatbox.resources

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

class ResourceStoreTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `preserves v2 snapshot shape ordering and source counts`() {
        val database = database()

        val snapshot = ResourceStore(database).snapshot()

        assertThat(snapshot.revision).isZero()
        assertThat(snapshot.regionCodes.map { it.code }).containsExactly("UNUSED", "Z001", "Z002")
        assertThat(snapshot.vehicles.map { it.id }).containsExactly("G1", "G2")
        assertThat(snapshot.source).isEqualTo(ResourceSourceView("legacy_vehicle_catalog", 3, 1))
    }

    @Test
    fun `mutations normalize values cascade renames and survive a new store`() {
        val database = database()
        val first = ResourceStore(database)

        assertThat(first.createRegionCode(0, "new").revision).isEqualTo(1)
        assertThat(first.assignVehicle(1, "G1", "new").revision).isEqualTo(2)
        assertThat(first.assignVehicle(2, "G2", "NEW").revision).isEqualTo(3)
        val renamed = first.renameRegionCode(3, "new", "next")

        assertThat(renamed.revision).isEqualTo(4)
        assertThat(renamed.vehicles.filter { it.regionCode == "NEXT" }).hasSize(2)
        val restarted = ResourceStore(database).snapshot()
        assertThat(restarted).isEqualTo(renamed)
    }

    @Test
    fun `validates a bulk change before writing and rolls back on every failure`() {
        val store = ResourceStore(database())
        val before = store.snapshot()

        val failures = listOf(
            listOf(VehicleAssignment("G1", "Z002"), VehicleAssignment("G1", null)),
            listOf(VehicleAssignment("UNKNOWN", null)),
            listOf(VehicleAssignment("G3", null)),
            listOf(VehicleAssignment("G1", "MISSING")),
            emptyList(),
        )
        failures.forEach { assignments ->
            assertThatThrownBy { store.assignVehicles(0, assignments) }.isInstanceOf(ResourceException::class.java)
            assertThat(store.snapshot()).isEqualTo(before)
        }

        val saved = store.assignVehicles(
            0,
            listOf(VehicleAssignment("G1", "Z002"), VehicleAssignment("G2", "Z001")),
        )
        assertThat(saved.revision).isEqualTo(1)
        assertThatThrownBy { store.assignVehicle(0, "G1", null) }
            .isInstanceOfSatisfying(ResourceException::class.java) { error ->
                assertThat(error.status).isEqualTo(409)
                assertThat(error.code).isEqualTo("RESOURCE_REVISION_CONFLICT")
            }
        assertThat(store.snapshot()).isEqualTo(saved)
    }

    @Test
    fun `serializes concurrent writers so one stale revision is rejected without lost updates`() {
        val store = ResourceStore(database())
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        val futures = listOf("A", "B").map { code ->
            executor.submit<Any> {
                ready.countDown()
                start.await()
                runCatching { store.createRegionCode(0, code) }.fold({ it }, { it })
            }
        }
        ready.await()
        start.countDown()

        val outcomes = futures.map { it.get() }
        executor.shutdownNow()
        assertThat(outcomes.filterIsInstance<ResourceSnapshot>()).hasSize(1)
        val conflict = outcomes.filterIsInstance<ResourceException>().single()
        assertThat(conflict.status).isEqualTo(409)
        assertThat(conflict.code).isEqualTo("RESOURCE_REVISION_CONFLICT")
        assertThat(store.snapshot().revision).isEqualTo(1)
    }

    @Test
    fun `rejects v1 unrelated missing and symlink databases without changing or creating them`() {
        val v1 = directory.resolve("v1.sqlite")
        createV1Database(v1)
        val before = Files.readAllBytes(v1)
        assertUnavailable(v1)
        assertThat(Files.readAllBytes(v1)).isEqualTo(before)

        val unrelated = directory.resolve("unrelated.sqlite")
        Files.writeString(unrelated, "not a database")
        val unrelatedBefore = Files.readAllBytes(unrelated)
        assertUnavailable(unrelated)
        assertThat(Files.readAllBytes(unrelated)).isEqualTo(unrelatedBefore)

        val missing = directory.resolve("missing.sqlite")
        assertUnavailable(missing)
        assertThat(missing).doesNotExist()

        val link = directory.resolve("linked.sqlite")
        runCatching { Files.createSymbolicLink(link, v1.fileName) }.onSuccess { assertUnavailable(link) }
    }

    private fun database(): Path = directory.resolve("resources.sqlite").also(::createV2Database)

    private fun assertUnavailable(database: Path) {
        assertThatThrownBy { ResourceStore(database).snapshot() }
            .isInstanceOfSatisfying(ResourceException::class.java) { error ->
                assertThat(error.status).isEqualTo(503)
                assertThat(error.code).isEqualTo("RESOURCE_DATABASE_UNAVAILABLE")
                assertThat(error.message).doesNotContain(database.toString())
            }
    }
}
