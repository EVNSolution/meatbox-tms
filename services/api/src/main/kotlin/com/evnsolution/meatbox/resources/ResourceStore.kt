package com.evnsolution.meatbox.resources

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import jakarta.servlet.http.HttpServletResponse

data class ResourceSnapshot(
    val revision: Long,
    val regionCodes: List<RegionCodeView>,
    val vehicles: List<VehicleView>,
    val source: ResourceSourceView,
)

data class RegionCodeView(val code: String)

data class VehicleView(
    val id: String,
    val plate: String,
    val regionCode: String?,
)

data class ResourceSourceView(
    val kind: String,
    val importedCount: Long,
    val excludedCount: Long,
)

data class VehicleAssignment(
    val id: String,
    val regionCode: String?,
)

class ResourceException(
    val status: Int,
    val code: String,
    override val message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

class ResourceStore(private val database: Path) {
    fun snapshot(): ResourceSnapshot = connection { connection ->
        transaction(connection, "BEGIN") { readSnapshot(connection) }
    }

    fun createRegionCode(revision: Long, code: String): ResourceSnapshot {
        val normalized = normalizeRegionCode(code)
        return mutate(revision) { connection ->
            if (connection.prepareStatement("SELECT 1 FROM region_codes WHERE code=?").use { statement ->
                    statement.setString(1, normalized)
                    statement.executeQuery().use { it.next() }
                }
            ) {
                throw ResourceException(HttpServletResponse.SC_CONFLICT, "REGION_CODE_EXISTS", "이미 등록된 지역 코드입니다.")
            }
            connection.prepareStatement("INSERT INTO region_codes(code) VALUES (?)").use { statement ->
                statement.setString(1, normalized)
                statement.executeUpdate()
            }
        }
    }

    fun renameRegionCode(revision: Long, oldCode: String, newCode: String): ResourceSnapshot {
        val oldNormalized = normalizeRegionCode(oldCode)
        val normalized = normalizeRegionCode(newCode)
        return mutate(revision) { connection ->
            if (!regionCodeExists(connection, oldNormalized)) {
                throw ResourceException(HttpServletResponse.SC_NOT_FOUND, "REGION_CODE_NOT_FOUND", "지역 코드를 찾을 수 없습니다.")
            }
            if (regionCodeExists(connection, normalized)) {
                throw ResourceException(HttpServletResponse.SC_CONFLICT, "REGION_CODE_EXISTS", "이미 등록된 지역 코드입니다.")
            }
            connection.prepareStatement("UPDATE region_codes SET code=? WHERE code=?").use { statement ->
                statement.setString(1, normalized)
                statement.setString(2, oldNormalized)
                statement.executeUpdate()
            }
        }
    }

    fun assignVehicles(revision: Long, assignments: List<VehicleAssignment>): ResourceSnapshot {
        val normalized = normalizeAssignments(assignments)
        return mutate(revision) { connection ->
            val activeIds = queryStrings(connection, "SELECT id FROM vehicles WHERE active=1", "id").toSet()
            val knownCodes = queryStrings(connection, "SELECT code FROM region_codes", "code").toSet()
            validateAssignments(normalized, activeIds, knownCodes)
            connection.prepareStatement("UPDATE vehicles SET region_code=? WHERE id=?").use { statement ->
                normalized.forEach { assignment ->
                    statement.setString(1, assignment.regionCode)
                    statement.setString(2, assignment.id)
                    statement.addBatch()
                }
                statement.executeBatch()
            }
        }
    }

    fun assignVehicle(revision: Long, id: String, regionCode: String?): ResourceSnapshot =
        assignVehicles(revision, listOf(VehicleAssignment(id, regionCode)))

    private fun mutate(revision: Long, action: (Connection) -> Unit): ResourceSnapshot {
        validateRevision(revision)
        return connection { connection ->
            transaction(connection, "BEGIN IMMEDIATE") {
                val current = connection.prepareStatement(
                    "SELECT revision FROM source_catalog WHERE id=1",
                ).use { statement ->
                    statement.executeQuery().use { results ->
                        if (!results.next()) unavailable()
                        results.getLong("revision")
                    }
                }
                if (current != revision) {
                    throw ResourceException(
                        HttpServletResponse.SC_CONFLICT,
                        "RESOURCE_REVISION_CONFLICT",
                        "자원 등록부가 변경되었습니다. 새로고침 후 다시 시도해 주세요.",
                    )
                }
                action(connection)
                val changed = connection.prepareStatement(
                    "UPDATE source_catalog SET revision=revision+1 WHERE id=1",
                ).use { it.executeUpdate() }
                if (changed != 1) unavailable()
                readSnapshot(connection)
            }
        }
    }

    private fun readSnapshot(connection: Connection): ResourceSnapshot {
        val source = connection.prepareStatement(
            "SELECT kind, imported_count, excluded_count, revision FROM source_catalog WHERE id=1",
        ).use { statement ->
            statement.executeQuery().use { results ->
                if (!results.next()) unavailable()
                Pair(
                    results.getLong("revision"),
                    ResourceSourceView(
                        results.getString("kind"),
                        results.getLong("imported_count"),
                        results.getLong("excluded_count"),
                    ),
                )
            }
        }
        val regionCodes = queryStrings(connection, "SELECT code FROM region_codes ORDER BY code", "code")
            .map(::RegionCodeView)
        val vehicles = connection.prepareStatement(
            "SELECT id, plate, region_code FROM vehicles " +
                "WHERE active=1 ORDER BY region_code IS NULL, region_code, plate, id",
        ).use { statement ->
            statement.executeQuery().use { results ->
                buildList {
                    while (results.next()) {
                        add(
                            VehicleView(
                                results.getString("id"),
                                results.getString("plate"),
                                results.getString("region_code"),
                            ),
                        )
                    }
                }
            }
        }
        return ResourceSnapshot(source.first, regionCodes, vehicles, source.second)
    }

    @Suppress("TooGenericExceptionCaught")
    private fun connection(action: (Connection) -> ResourceSnapshot): ResourceSnapshot {
        try {
            if (!Files.isRegularFile(database, LinkOption.NOFOLLOW_LINKS)) unavailable()
            val url = "jdbc:sqlite:file:${database.toUri().rawPath}?mode=rw"
            return DriverManager.getConnection(url).use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute("PRAGMA foreign_keys=ON")
                    statement.execute("PRAGMA busy_timeout=$BUSY_TIMEOUT_MILLIS")
                }
                validateSchema(connection)
                action(connection)
            }
        } catch (error: ResourceException) {
            throw error
        } catch (error: Exception) {
            unavailable(error)
        }
    }

    private fun validateSchema(connection: Connection) {
        val version = connection.createStatement().use { statement ->
            statement.executeQuery("PRAGMA user_version").use { results ->
                if (!results.next()) unavailable()
                results.getInt(1)
            }
        }
        if (version != EXPECTED_SCHEMA_VERSION) unavailable()
        connection.prepareStatement("SELECT fingerprint FROM source_catalog WHERE id=1").use { statement ->
            statement.executeQuery().use { results ->
                if (!results.next() || results.getString("fingerprint").isNullOrEmpty()) unavailable()
            }
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun <T> transaction(connection: Connection, begin: String, action: () -> T): T {
        connection.createStatement().use { it.execute(begin) }
        return try {
            val result = action()
            connection.createStatement().use { it.execute("COMMIT") }
            result
        } catch (error: Exception) {
            runCatching { connection.createStatement().use { it.execute("ROLLBACK") } }
            throw error
        }
    }

    private fun regionCodeExists(connection: Connection, code: String): Boolean =
        connection.prepareStatement("SELECT 1 FROM region_codes WHERE code=?").use { statement ->
            statement.setString(1, code)
            statement.executeQuery().use { it.next() }
        }

    companion object {
        private const val EXPECTED_SCHEMA_VERSION = 2
        private const val BUSY_TIMEOUT_MILLIS = 5_000
    }
}

private const val MAX_ASSIGNMENTS = 1_000
private const val MAX_VEHICLE_ID_LENGTH = 128
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val REGION_CODE = Regex("^[A-Za-z][A-Za-z0-9]{0,39}$")

private fun normalizeAssignments(assignments: List<VehicleAssignment>): List<VehicleAssignment> {
    if (assignments.isEmpty() || assignments.size > MAX_ASSIGNMENTS) {
        throw ResourceException(
            HttpServletResponse.SC_BAD_REQUEST,
            "INVALID_ASSIGNMENTS",
            "변경할 차량을 1~1000개 선택해 주세요.",
        )
    }
    val seen = mutableSetOf<String>()
    return assignments.map { assignment ->
        val validId = assignment.id.isNotEmpty() && assignment.id.length <= MAX_VEHICLE_ID_LENGTH
        if (!validId || !seen.add(assignment.id)) {
            throw ResourceException(
                HttpServletResponse.SC_BAD_REQUEST,
                "INVALID_ASSIGNMENTS",
                "차량 목록에 중복되거나 잘못된 항목이 있습니다.",
            )
        }
        assignment.copy(regionCode = assignment.regionCode?.let(::normalizeRegionCode))
    }
}

private fun validateAssignments(
    assignments: List<VehicleAssignment>,
    activeIds: Set<String>,
    knownCodes: Set<String>,
) {
    assignments.forEach { assignment ->
        if (assignment.id !in activeIds) {
            throw ResourceException(HttpServletResponse.SC_NOT_FOUND, "VEHICLE_NOT_FOUND", "활성 차량을 찾을 수 없습니다.")
        }
        if (assignment.regionCode != null && assignment.regionCode !in knownCodes) {
            throw ResourceException(
                HttpServletResponse.SC_BAD_REQUEST,
                "REGION_CODE_NOT_FOUND",
                "등록된 지역 코드를 선택해 주세요.",
            )
        }
    }
}

private fun queryStrings(connection: Connection, sql: String, column: String): List<String> =
    connection.prepareStatement(sql).use { statement ->
        statement.executeQuery().use { results ->
            buildList { while (results.next()) add(results.getString(column)) }
        }
    }

private fun normalizeRegionCode(value: String): String {
    if (!REGION_CODE.matches(value)) {
        throw ResourceException(
            HttpServletResponse.SC_BAD_REQUEST,
            "INVALID_REGION_CODE",
            "지역 코드는 영문자로 시작하고 영문·숫자만 사용할 수 있습니다.",
        )
    }
    return value.uppercase()
}

private fun validateRevision(revision: Long) {
    if (revision < 0 || revision > MAX_SAFE_INTEGER) {
        throw ResourceException(
            HttpServletResponse.SC_BAD_REQUEST,
            "INVALID_REVISION",
            "최신 자원 정보를 다시 불러와 주세요.",
        )
    }
}

private fun unavailable(cause: Throwable? = null): Nothing = throw ResourceException(
    HttpServletResponse.SC_SERVICE_UNAVAILABLE,
    "RESOURCE_DATABASE_UNAVAILABLE",
    "자원 등록부를 사용할 수 없습니다.",
    cause,
)
