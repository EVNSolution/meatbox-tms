package com.evnsolution.meatbox.export

import com.evnsolution.meatbox.dispatch.DispatchException
import java.time.LocalDate

/** The parts of an archive that a request can leave out. `manifest.json` is always there. */
val EXPORT_GROUPS: Set<String> = linkedSetOf("orders", "dispatch", "driver", "photos", "telemetry", "resources")

private const val BAD_REQUEST = 400

/** Which dates (inclusive, both optional) and which [include] groups an archive holds. */
class ExportRequest private constructor(val from: String?, val to: String?, val include: Set<String>) {
    fun inRange(date: String): Boolean = (from == null || date >= from) && (to == null || date <= to)

    fun has(group: String): Boolean = group in include

    companion object {
        /** Throws 400 `INVALID_EXPORT` for a bad calendar date, a reversed range or an unknown group. */
        fun of(from: String?, to: String?, include: Collection<String>?): ExportRequest {
            val start = from?.takeIf(String::isNotBlank)?.also(::validDate)
            val end = to?.takeIf(String::isNotBlank)?.also(::validDate)
            if (start != null && end != null && start > end) invalid("from is after to")
            val groups = include?.toSet() ?: EXPORT_GROUPS
            if (groups.isEmpty() || !EXPORT_GROUPS.containsAll(groups)) invalid("include must name known groups")
            return ExportRequest(start, end, EXPORT_GROUPS.filter(groups::contains).toSet())
        }

        private fun validDate(value: String) {
            val valid = runCatching { LocalDate.parse(value).toString() == value }.getOrDefault(false)
            if (!valid) invalid("dates look like 2026-10-14")
        }

        private fun invalid(detail: String): Nothing = throw DispatchException(BAD_REQUEST, "INVALID_EXPORT", detail)
    }
}
