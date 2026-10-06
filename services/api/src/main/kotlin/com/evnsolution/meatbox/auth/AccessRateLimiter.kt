package com.evnsolution.meatbox.auth

import java.util.LinkedHashMap

internal class AccessRateLimiter(
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val entries = LinkedHashMap<String, RateEntry>()

    @Synchronized
    fun allow(key: String): Boolean {
        val current = now()
        entries.entries.removeIf { it.value.until <= current }
        val entry = entries[key]?.takeIf { it.until > current } ?: RateEntry(0, current + WINDOW_MILLIS)
        if (entries.size >= MAX_KEYS && key !in entries) entries.remove(entries.entries.first().key)
        entry.count += 1
        entries[key] = entry
        return entry.count <= MAX_REQUESTS
    }

    @Synchronized
    fun retryAfterSeconds(): Long {
        val current = now()
        return entries.values.maxOfOrNull {
            ((it.until - current).coerceAtLeast(0) + MILLIS_ROUND_UP) / MILLIS_PER_SECOND
        } ?: MINIMUM_RETRY_SECONDS
    }

    private data class RateEntry(var count: Int, val until: Long)

    companion object {
        private const val MAX_REQUESTS = 20
        private const val WINDOW_MILLIS = 15 * 60 * 1_000L
        private const val MAX_KEYS = 10_000
        private const val MILLIS_ROUND_UP = 999
        private const val MILLIS_PER_SECOND = 1_000
        private const val MINIMUM_RETRY_SECONDS = 1L
    }
}
