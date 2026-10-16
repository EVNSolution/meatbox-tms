import dev.detekt.gradle.Detekt

plugins {
    kotlin("jvm") version "2.3.21"
    kotlin("plugin.spring") version "2.3.21"
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("dev.detekt") version "2.0.0-alpha.3"
}

group = "com.evnsolution.meatbox"
version = "0.0.1-SNAPSHOT"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("tools.jackson.module:jackson-module-kotlin")
    implementation(kotlin("reflect"))
    implementation("org.xerial:sqlite-jdbc:3.53.4.0")
    implementation("com.ibm.icu:icu4j:78.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// The archive manifest names the server that wrote it. No build time: it would make every build of one commit differ.
springBoot {
    buildInfo {
        excludes = setOf("time")
        properties { additional = mapOf("commit" to (System.getenv("GITHUB_SHA") ?: "unknown")) }
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

detekt {
    toolVersion = "2.0.0-alpha.3"
    buildUponDefaultConfig = true
    allRules = false
    ignoreFailures = false
    parallel = false
    config.setFrom(files("config/detekt/detekt.yml"))
}

tasks.withType<Detekt>().configureEach {
    jvmTarget = "21"
    reports {
        html.required = true
        sarif.required = true
        checkstyle.required = false
        markdown.required = false
    }
}
