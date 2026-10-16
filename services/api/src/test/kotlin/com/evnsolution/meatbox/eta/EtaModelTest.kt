package com.evnsolution.meatbox.eta

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Duration
import java.time.Instant

class EtaModelTest {
    private val departure = Instant.parse("2026-10-13T01:00:00Z")
    private val origin = EtaPoint(37.5, 127.0)

    // 0.05 degrees of longitude at 37.5 N is about 4.4 km.
    private fun stop(id: String, lngOffset: Double?) = EtaStopInput(id, lngOffset?.let { EtaPoint(37.5, 127.0 + it) })

    @Test
    fun `arrivals grow along the route and a stop without coordinates only adds the previous work time`() {
        val stops = listOf(stop("A", 0.05), stop("B", 0.1), stop("C", null), stop("D", 0.15))
        val result = EtaModel().compute(stops, departure, origin)

        assertThat(result.map { it.sequence }).containsExactly(1, 2, 3, 4)
        assertThat(result.map { it.estimated }).containsExactly(true, true, false, true)
        assertThat(result.map { it.eta }).isSorted()
        val leg = Duration.between(departure, result[0].eta).toMinutes()
        assertThat(leg).isBetween(14, 16) // 4.4 km x 1.4 / 25 km/h = 14.8 min
        assertThat(Duration.between(result[1].eta, result[2].eta)).isEqualTo(Duration.ofMinutes(5))
        // The leg after the unlocated stop starts from the last known point (B), so it is one leg plus work times.
        assertThat(Duration.between(result[2].eta, result[3].eta).toMinutes()).isBetween(19, 21)
    }

    @Test
    fun `no origin makes the first stop arrive at the departure with estimated false`() {
        val result = EtaModel().compute(listOf(stop("A", 0.05), stop("B", 0.1)), departure, null)
        assertThat(result[0].eta).isEqualTo(departure)
        assertThat(result[0].estimated).isFalse()
        assertThat(result[1].estimated).isTrue()
    }

    @Test
    fun `the settings change the result`() {
        val stops = listOf(stop("A", 0.05), stop("B", 0.1))
        val base = EtaModel().compute(stops, departure, origin).last().eta
        assertThat(EtaModel(EtaConfig(speedKmh = 50.0)).compute(stops, departure, origin).last().eta).isBefore(base)
        assertThat(EtaModel(EtaConfig(detourFactor = 2.0)).compute(stops, departure, origin).last().eta).isAfter(base)
        assertThat(EtaModel(EtaConfig(serviceMinutes = 10)).compute(stops, departure, origin).last().eta)
            .isEqualTo(base.plus(Duration.ofMinutes(5)))
    }

    @Test
    fun `another estimator replaces the straight-line one`() {
        val fixed = EtaModel(EtaConfig(serviceMinutes = 0), { _, _ -> 600 })
        val result = fixed.compute(listOf(stop("A", 0.05), stop("B", 0.1)), departure, origin)
        assertThat(result.map { Duration.between(departure, it.eta).toMinutes() }).containsExactly(10L, 20L)
    }

    @Test
    fun `rejects settings that cannot give a travel time`() {
        assertThatThrownBy { EtaConfig(detourFactor = 0.0) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { EtaConfig(speedKmh = -1.0) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { EtaConfig(serviceMinutes = -1) }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
