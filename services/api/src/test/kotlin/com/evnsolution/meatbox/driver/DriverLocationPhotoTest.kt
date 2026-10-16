package com.evnsolution.meatbox.driver

import com.evnsolution.meatbox.dispatch.DispatchException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class DriverLocationPhotoTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `keeps the latest 120 samples per vehicle and reports the newest one as the vehicle position`() {
        val f = routeFixture(directory)
        assertThat(f.vehicleLocation().path("source").asString()).isEqualTo("demo")
        assertThat(f.driver.activity.acceptLocations(DRIVER_DATE, "G1", samples(0, 200)).path("retained").asInt())
            .isEqualTo(120)
        // A resent batch changes nothing, and a newer one pushes the oldest samples out.
        assertThat(f.driver.activity.acceptLocations(DRIVER_DATE, "G1", samples(0, 200)).path("retained").asInt())
            .isEqualTo(120)
        f.driver.activity.acceptLocations(DRIVER_DATE, "G1", samples(200, 10))
        val saved = f.stateFile().path("locations").path("G1")
        assertThat(saved.size()).isEqualTo(120)
        assertThat(saved.first().path("at").asString()).isEqualTo(at(90))
        val vehicle = f.vehicleLocation()
        assertThat(vehicle.path("source").asString()).isEqualTo("driver")
        assertThat(vehicle.path("at").asString()).isEqualTo(at(209))
        assertThat(vehicle.path("coordinates").first().doubleValue()).isEqualTo(127.0 + 209 / 10000.0)
        assertThat(f.restarted().vehicleLocation().path("source").asString()).isEqualTo("driver")
        val version = f.snapshot().path("sourceData").path("driverLocationVersion")
        assertThat(version.asLong()).isEqualTo(3)
    }

    @Test
    fun `stores and returns photos and rejects unsafe ones`() {
        val activity = routeFixture(directory).driver.activity
        val saved = activity.savePhoto(DRIVER_DATE, JPEG)
        assertThat(saved.path("bytes").asInt()).isEqualTo(JPEG.size)
        val read = activity.readPhoto(DRIVER_DATE, saved.path("photoId").asString())
        assertThat(read.bytes).isEqualTo(JPEG)
        assertThat(read.contentType).isEqualTo("image/jpeg")
        assertCode(415, "UNSUPPORTED_PHOTO_TYPE") { activity.savePhoto(DRIVER_DATE, "GIF89a".toByteArray()) }
        assertCode(400, "INVALID_PHOTO_ID") { activity.readPhoto(DRIVER_DATE, "../../driver-$DRIVER_DATE") }
        assertCode(404, "PHOTO_NOT_FOUND") { activity.readPhoto(DRIVER_DATE, "00000000-0000-4000-8000-000000000000") }
    }

    private fun assertCode(status: Int, code: String, block: () -> Unit) {
        assertThatThrownBy(block).isInstanceOfSatisfying(DispatchException::class.java) {
            assertThat(it.status).isEqualTo(status)
            assertThat(it.code).isEqualTo(code)
        }
    }

    private fun RouteFixture.snapshot() = dispatch.snapshot(DRIVER_DATE)

    private fun RouteFixture.vehicleLocation() = snapshot().path("fleetVehicles").first().path("location")

    private fun RouteFixture.stateFile() = driverJson.readTree(state.resolve("driver-$DRIVER_DATE.json").toFile())

    private fun at(index: Int) = "2026-10-13T09:%02d:%02d+09:00".format(index / 60 % 60, index % 60)

    private fun samples(from: Int, count: Int) = driverJson.createArrayNode().apply {
        (from until from + count).forEach {
            addObject().put("at", at(it)).put("lat", 37.5).put("lng", 127.0 + it / 10000.0).put("accuracyM", 8)
        }
    }

    companion object {
        val JPEG = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3, 4)
    }
}
