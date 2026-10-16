package com.evnsolution.meatbox.export

import java.nio.file.Path
import java.sql.DriverManager

/**
 * The vehicle register and the region codes from the resource SQLite file, read in one read-only transaction.
 * Unlike the API view this keeps inactive vehicles and the original catalog code.
 */
internal fun readRegistry(database: Path): Pair<ByteArray, ByteArray> {
    val url = "jdbc:sqlite:file:${database.toUri().rawPath}?mode=ro"
    DriverManager.getConnection(url).use { connection ->
        connection.autoCommit = false
        val source = connection.createStatement().use { statement ->
            statement.executeQuery(
                "SELECT kind, imported_count, excluded_count, revision FROM source_catalog WHERE id=1",
            ).use { rows ->
                    check(rows.next())
                    exportJson.createObjectNode().put("kind", rows.getString("kind"))
                        .put("importedCount", rows.getLong("imported_count"))
                        .put("excludedCount", rows.getLong("excluded_count")) to rows.getLong("revision")
                }
        }
        val vehicles = exportJson.createObjectNode().put("revision", source.second)
        vehicles.set("source", source.first)
        val list = vehicles.putArray("vehicles")
        connection.createStatement().use { statement ->
            statement.executeQuery(
                "SELECT id, plate, original_code, active, region_code FROM vehicles ORDER BY id",
            ).use { rows ->
                while (rows.next()) {
                    list.addObject().put("id", rows.getString("id")).put("plate", rows.getString("plate"))
                        .put("originalCode", rows.getString("original_code"))
                        .put("active", rows.getInt("active") == 1).put("regionCode", rows.getString("region_code"))
                }
            }
        }
        val codes = exportJson.createObjectNode().put("revision", source.second)
        val codeList = codes.putArray("regionCodes")
        connection.createStatement().use { statement ->
            statement.executeQuery("SELECT code FROM region_codes ORDER BY code").use { rows ->
                while (rows.next()) codeList.add(rows.getString("code"))
            }
        }
        val writer = exportJson.writerWithDefaultPrettyPrinter()
        return writer.writeValueAsBytes(vehicles) to writer.writeValueAsBytes(codes)
    }
}
