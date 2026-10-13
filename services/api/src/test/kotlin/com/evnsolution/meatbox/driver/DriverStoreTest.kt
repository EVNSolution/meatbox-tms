package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.nio.file.attribute.PosixFilePermissions

class DriverStoreTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `persists messages and token rotation without exposing device secrets`() {
        val (store, state) = driverFixture(directory)
        store.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "old-token", "device")
        store.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "new-token", "device")
        val sent = store.append(DRIVER_DATE, "G1", "ops", "출발해 주세요")
        assertThat(sent.tokens).containsExactly("new-token")
        assertThat(sent.message.path("from").asString()).isEqualTo("ops")
        assertThat(Files.getPosixFilePermissions(state.resolve("driver-$DRIVER_DATE.json")))
            .isEqualTo(PosixFilePermissions.fromString("rw-------"))
        val (restored) = driverFixture(directory)
        assertThat(restored.messages(DRIVER_DATE, "G1").path("messages").size()).isEqualTo(1)
        assertThat(restored.messages(DRIVER_DATE, "G1").toString()).doesNotContain("token", "device", "username")
        store.unregister(DRIVER_DATE, "different-user", "new-token")
        assertThat(store.append(DRIVER_DATE, "G1", "ops", "확인").tokens).containsExactly("new-token")
        store.unregister(DRIVER_DATE, "demo", "new-token")
        assertThat(store.append(DRIVER_DATE, "G1", "ops", "확인").tokens).isEmpty()
        assertThat(store.append(DRIVER_DATE, "G1", "driver", "수신했습니다").tokens).isEmpty()
    }

    @Test
    fun `rejects invalid dates missing vehicles and unsafe checkpoint targets`() {
        val (store, state) = driverFixture(directory)
        for (date in listOf("../2026-10-13", "2026-02-30", "2026-10-13/")) {
            assertThatThrownBy { store.messages(date, "G1") }.isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("INVALID_DATE")
            }
        }
        assertThatThrownBy { store.append(DRIVER_DATE, "missing", "ops", "x") }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DRIVER_VEHICLE_NOT_FOUND")
            }
        val outside = directory.resolve("private.json")
        Files.writeString(outside, "preserve")
        Files.createSymbolicLink(state.resolve("driver-$DRIVER_DATE.json"), outside)
        assertThatThrownBy { store.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "token", "device") }
            .isInstanceOf(DispatchException::class.java)
        assertThat(Files.readString(outside)).isEqualTo("preserve")
    }

    @Test
    fun `serializes different store instances and fails bounded when another process owns the lock`() {
        val (first, state) = driverFixture(directory)
        val (second) = driverFixture(directory)
        Executors.newFixedThreadPool(2).use { pool ->
            val writes = (1..20).map { index -> pool.submit {
                val store = if (index % 2 == 0) first else second
                store.append(DRIVER_DATE, "G1", "driver", "message-$index")
            } }
            writes.forEach { it.get(30, TimeUnit.SECONDS) }
        }
        assertThat(first.messages(DRIVER_DATE, "G1").path("messages").size()).isEqualTo(20)
        FileChannel.open(state.resolve(".driver-state.lock"), StandardOpenOption.WRITE).use { channel ->
            channel.lock().use {
                assertThatThrownBy { second.append(DRIVER_DATE, "G1", "driver", "locked") }
                    .isInstanceOfSatisfying(DispatchException::class.java) {
                        assertThat(it.code).isEqualTo("DRIVER_STATE_BUSY")
                    }
            }
        }
        assertThat(first.messages(DRIVER_DATE, "G1").path("messages").size()).isEqualTo(20)
    }

    @Test
    fun `blocks historical writes while allowing reads and token withdrawal`() {
        val (current) = driverFixture(directory)
        current.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "token", "device")
        current.append(DRIVER_DATE, "G1", "driver", "saved")
        val (history) = driverFixture(directory, "2026-10-14")
        assertThat(history.messages(DRIVER_DATE, "G1").path("messages").size()).isEqualTo(1)
        assertThatThrownBy { history.append(DRIVER_DATE, "G1", "ops", "blocked") }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DRIVER_DATE_READ_ONLY")
            }
        assertThatThrownBy { history.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "token", "device") }
            .isInstanceOfSatisfying(DispatchException::class.java) {
                assertThat(it.code).isEqualTo("DRIVER_DATE_READ_ONLY")
            }
        history.unregister(DRIVER_DATE, "demo", "token")
        assertThat(current.append(DRIVER_DATE, "G1", "ops", "current").tokens).isEmpty()
    }

    @Test
    fun `prunes revoked session bindings before capacity checks and push selection`() {
        val active = mutableSetOf(DRIVER_DIGEST)
        val (store, state) = driverFixture(directory, isSessionActive = { digest, _ -> digest in active })
        repeat(3) { store.register(DRIVER_DATE, "demo", DRIVER_DIGEST, "G1", "old-$it", "old-$it") }
        active.clear()
        val next = "b".repeat(64)
        active.add(next)
        store.register(DRIVER_DATE, "demo", next, "G1", "new", "new")
        assertThat(store.append(DRIVER_DATE, "G1", "ops", "message").tokens).containsExactly("new")
        active.clear()
        assertThat(store.append(DRIVER_DATE, "G1", "ops", "message").tokens).isEmpty()
        assertThat(driverJson.readTree(Files.readString(state.resolve("driver-$DRIVER_DATE.json")))
            .path("devices").size()).isZero()
        assertThatThrownBy { store.register(DRIVER_DATE, "demo", next, "G1", "invalid", "invalid") }
            .isInstanceOfSatisfying(DispatchException::class.java) { assertThat(it.status).isEqualTo(401) }
    }

    @Test
    fun `does not report success or retain messages after persistence fails`() {
        val (store, state) = driverFixture(directory)
        store.append(DRIVER_DATE, "G1", "driver", "first")
        val before = Files.readAllBytes(state.resolve("driver-$DRIVER_DATE.json"))
        Files.setPosixFilePermissions(state, PosixFilePermissions.fromString("r-x------"))
        try {
            assertThatThrownBy { store.append(DRIVER_DATE, "G1", "driver", "unsaved") }
                .isInstanceOfSatisfying(DispatchException::class.java) {
                    assertThat(it.code).isEqualTo("DRIVER_STATE_WRITE_FAILED")
                }
        } finally {
            Files.setPosixFilePermissions(state, PosixFilePermissions.fromString("rwx------"))
        }
        assertThat(Files.readAllBytes(state.resolve("driver-$DRIVER_DATE.json"))).isEqualTo(before)
        assertThat(store.messages(DRIVER_DATE, "G1").path("messages").size()).isEqualTo(1)
    }
}
