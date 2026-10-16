package com.evnsolution.meatbox.driver

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * The extra fee for a driver's delivered amount above the daily target: `unit` counts `boxes`, `stops` or `orders`;
 * a driver in [targetsByDriver] has their own target, everyone else has [dailyTarget]; every unit above the target
 * earns [ratePerUnit] won.
 */
class IncentiveRules(
    val unit: String,
    val dailyTarget: Double,
    val ratePerUnit: Double,
    val targetsByDriver: Map<String, Double>,
) {
    fun targetOf(driver: String?): Double = driver?.let(targetsByDriver::get) ?: dailyTarget

    fun toNode(): ObjectNode = driverJson.createObjectNode().apply {
        put("unit", unit).put("dailyTarget", dailyTarget).put("ratePerUnit", ratePerUnit)
        putObject("targetsByDriver").also { targets -> targetsByDriver.toSortedMap().forEach(targets::put) }
    }
}

/**
 * `{state-dir}/incentive-rules.json`, written by hand by an operator (see the operations runbook). The file is read on
 * every call. No file means no rule: the dashboard then shows no fee. An unreadable or invalid file is a failure
 * that the dashboard names, never a rule of zero.
 */
class IncentiveRulesFile(private val file: Path) {
    sealed interface Result {
        data object Missing : Result
        data object Invalid : Result
        class Found(val rules: IncentiveRules) : Result
    }

    fun read(): Result {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return Result.Missing
        return runCatching { Result.Found(parse()) }.getOrDefault(Result.Invalid)
    }

    private fun parse(): IncentiveRules {
        check(Files.size(file) <= MAX_BYTES)
        val root = driverJson.readTree(Files.readAllBytes(file)) as ObjectNode
        val unit = root.path("unit")
        check(unit.isString && unit.asString() in UNITS)
        val own = root.path("targetsByDriver")
        check(!root.has("targetsByDriver") || own.isObject)
        val targets = own.properties().associate { (name, value) -> name to amount(value) }
        val target = amount(root.path("dailyTarget"))
        return IncentiveRules(unit.asString(), target, amount(root.path("ratePerUnit")), targets)
    }

    private fun amount(value: JsonNode): Double {
        check(value.isNumber && value.asDouble() >= 0 && value.asDouble().isFinite())
        return value.asDouble()
    }

    private companion object {
        val UNITS = setOf("boxes", "stops", "orders")
        const val MAX_BYTES = 256L * 1024
    }
}
