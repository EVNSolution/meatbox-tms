# Meatbox API environment

This directory contains the Kotlin/Spring Boot API. The default mode exposes health only. Native mode owns authentication, sessions, imported source reads, the SQLite v2 resource registry, and dated dispatch state/commands. It preserves the existing access JSON v1 and dispatch checkpoint v2 contracts. Connected compatibility mode can still verify a Node session for migration comparisons; TEST runs native with the old Node API stopped.

## Toolchain

- Java toolchain 21
- Gradle Wrapper 9.3.0 with the official distribution checksum
- Spring Boot 4.1.1
- Kotlin JVM and Spring plugins 2.3.21
- detekt 2.0.0-alpha.3

detekt is intentionally pinned to an alpha release because this setup requires the Kotlin 2.3-compatible 2.x plugin line. The build uses default rules, config validation with warnings as errors, no formatting plugin, and no automatic correction.

## Commands

Use the repository's Homebrew JDK 21 path when the shell has no registered `JAVA_HOME`:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew --no-daemon check bootJar
./gradlew --no-daemon bootRun
```

The server binds to `127.0.0.1:8081` by default. Override only the port with `SERVER_PORT`. The environment smoke endpoint is `GET /actuator/health`; it exposes status without component details.

From the repository root, `make run-native-fixture` exercises the native owner without the Node API, `make run-connected-fixture` exercises the compatibility owner, and `make check-release` runs the complete Kotlin, frontend, golden, package and real-JAR contract checks. Inputs, accounts and databases are synthetic and isolated in temporary directories. [Development commands and offline account administration](../../docs/new-stack-development.md) describe the supported boundaries.

Native mode requires `MEATBOX_AUTH_ENABLED=true`, `MEATBOX_DISPATCH_ENABLED=true`, `MEATBOX_COMPAT_ENABLED=true`, `MEATBOX_RESOURCES_ENABLED=true`, exact `MEATBOX_PUBLIC_ORIGIN`, and absolute access/source/checkpoint/database paths. Set all three gateway owners to `kotlin`; the selected owner never falls back to Node on a failure. A missing or v1 resource database is rejected rather than created or migrated by a read request. Connected compatibility mode additionally uses an exact loopback `MEATBOX_LEGACY_API_ORIGIN` to verify the existing Node session when Kotlin authentication is disabled.

The SQLite driver is pinned to `org.xerial:sqlite-jdbc:3.53.4.0`; resource transactions use standard JDBC and the existing schema. See [upstream SQLite JDBC](https://github.com/xerial/sqlite-jdbc) and the [Java 21 transaction contract](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/Connection.html). Rollout conditions and verification are recorded in [the TEST rollout plan](../../docs/test-stack-rollout-plan.md).

Destination sorting uses `com.ibm.icu:icu4j:78.2`, matching the TEST Node runtime's ICU version. Korean name sorting enables numeric collation at PRIMARY strength; region sorting uses TERTIARY strength. JDK collation differed on spaces and punctuation in the real catalog, so its custom numeric comparator was removed. See the [ICU collation contract](https://unicode-org.github.io/icu/userguide/collation/customization/). Real catalog parity must pass before switching traffic.
