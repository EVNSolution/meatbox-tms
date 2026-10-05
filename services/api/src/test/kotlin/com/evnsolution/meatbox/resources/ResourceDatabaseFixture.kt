package com.evnsolution.meatbox.resources

import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager

internal fun createV2Database(path: Path) {
    Files.createDirectories(path.parent)
    DriverManager.getConnection("jdbc:sqlite:${path.toAbsolutePath()}").use { connection ->
        connection.createStatement().use { statement ->
            statement.executeUpdate(
                """
                CREATE TABLE source_catalog (
                  id INTEGER PRIMARY KEY CHECK (id=1), fingerprint TEXT NOT NULL,
                  kind TEXT NOT NULL, imported_count INTEGER NOT NULL,
                  excluded_count INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
                )
                """.trimIndent(),
            )
            statement.executeUpdate(
                """
                CREATE TABLE region_codes (
                  code TEXT PRIMARY KEY CHECK (
                    length(code) BETWEEN 1 AND 40 AND substr(code,1,1) GLOB '[A-Z]' AND
                    code NOT GLOB '*[^A-Z0-9]*'
                  )
                )
                """.trimIndent(),
            )
            statement.executeUpdate(
                """
                CREATE TABLE vehicles (
                  id TEXT PRIMARY KEY, plate TEXT NOT NULL, original_code TEXT,
                  active INTEGER NOT NULL CHECK (active IN (0,1)),
                  region_code TEXT REFERENCES region_codes(code) ON UPDATE CASCADE,
                  CHECK (active=1 OR region_code IS NULL)
                )
                """.trimIndent(),
            )
            statement.execute("PRAGMA user_version=2")
            statement.executeUpdate(
                "INSERT INTO source_catalog VALUES " +
                    "(1,'${"f".repeat(64)}','legacy_vehicle_catalog',3,1,0)",
            )
            statement.executeUpdate("INSERT INTO region_codes VALUES ('Z001'),('Z002'),('UNUSED')")
            statement.executeUpdate(
                """
                INSERT INTO vehicles(id,plate,original_code,active,region_code) VALUES
                  ('G1','11가 1001','Z001',1,'Z001'),
                  ('G2','12나 1002','Z002',1,'Z002'),
                  ('G3','13다 1003',NULL,0,NULL)
                """.trimIndent(),
            )
        }
    }
}

internal fun createV1Database(path: Path) {
    Files.createDirectories(path.parent)
    DriverManager.getConnection("jdbc:sqlite:${path.toAbsolutePath()}").use { connection ->
        connection.createStatement().use { statement ->
            statement.executeUpdate(
                "CREATE TABLE source_catalog " +
                    "(id INTEGER PRIMARY KEY, fingerprint TEXT, kind TEXT, imported_count INTEGER, " +
                    "excluded_count INTEGER, revision INTEGER)",
            )
            statement.executeUpdate("CREATE TABLE categories (code TEXT PRIMARY KEY)")
            statement.executeUpdate(
                "CREATE TABLE vehicles " +
                    "(id TEXT PRIMARY KEY, plate TEXT, original_code TEXT, active INTEGER, category_code TEXT)",
            )
            statement.execute("PRAGMA user_version=1")
            statement.executeUpdate(
                "INSERT INTO source_catalog VALUES " +
                    "(1,'${"f".repeat(64)}','legacy_vehicle_catalog',1,0,7)",
            )
            statement.executeUpdate("INSERT INTO categories VALUES ('Z001')")
            statement.executeUpdate("INSERT INTO vehicles VALUES ('G1','11가 1001','Z001',1,'Z001')")
        }
    }
}
