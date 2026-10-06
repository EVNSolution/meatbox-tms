// This is a statement-for-statement compatibility port of the deterministic Node calculator.
// Numeric geography bounds and long comparator expressions stay visible so parity reviews can compare both engines.
@file:Suppress(
    "MagicNumber",
    "MaxLineLength",
)

package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import kotlin.math.cos

object DispatchCalculator {
    @Suppress("ComplexCondition", "CyclomaticComplexMethod", "LongMethod", "ReturnCount")
    fun calculate(
        orders: ArrayNode,
        vehicles: List<ObjectNode>,
        vehicleIds: List<String>,
        units: List<ObjectNode>,
    ): ObjectNode {
        if (vehicleIds.isEmpty() || vehicleIds.distinct().size != vehicleIds.size) invalid("계산할 차량을 한 대 이상 선택해 주세요.")
        val vehicleById = linkedMapOf<String, ObjectNode>()
        vehicles.forEach { vehicle ->
            val id = vehicle.text("id")
            if (id.isNullOrEmpty() || vehicleById.putIfAbsent(id, vehicle) != null) invalid("차량 자료를 확인해 주세요.")
        }
        if (vehicleIds.any { it !in vehicleById }) invalid("선택한 차량을 차량 자료에서 찾을 수 없습니다.")

        val orderById = linkedMapOf<String, IndexedOrder>()
        orders.forEachIndexed { index, value ->
            val order = value as? ObjectNode ?: invalid("주문 자료를 확인해 주세요.")
            val id = order.text("id")
            val boxes = order["boxes"]?.takeIf(JsonNode::isNumber)?.doubleValue()
            if (id.isNullOrEmpty() || id in orderById || boxes == null || !boxes.isFinite() || boxes < 0) invalid("주문 자료를 확인해 주세요.")
            orderById[id] = IndexedOrder(order, index)
        }

        val covered = mutableSetOf<String>()
        val unitIds = mutableSetOf<String>()
        val normalized = units.mapIndexed { index, unit ->
            val id = unit.text("id")
            val orderIds = unit["orderIds"].strings()
            if (id.isNullOrEmpty() || !unitIds.add(id) || orderIds == null || orderIds.isEmpty() || orderIds.distinct().size != orderIds.size) {
                invalid("배송지 묶음을 확인해 주세요.")
            }
            val members = orderIds.map { orderId ->
                val order = orderById[orderId] ?: invalid("배송지 묶음의 주문을 확인해 주세요.")
                if (!covered.add(orderId)) invalid("배송지 묶음의 주문을 확인해 주세요.")
                order
            }
            val points = members.mapNotNull { coordinateOf(it.value) }
            UnitData(
                id = id,
                index = index,
                orderIds = orderIds,
                boxes = members.sumOf { it.value["boxes"].doubleValue() },
                points = points,
                coordinate = centroid(points),
                zoneIds = members.flatMap { zones(it.value) }.distinct(),
            )
        }
        if (covered.size != orderById.size) invalid("모든 주문이 하나의 배송지 묶음에 포함되어야 합니다.")

        val territoryUnits = mergeTerritories(normalized)
        val vehicleOrder = vehicleIds.withIndex().associate { (index, id) -> id to index }
        val vehicleCentroids = vehicleIds.associateWith { vehicleId ->
            centroid(orderById.values.filter { it.value.text("groupId") == vehicleId }.mapNotNull { coordinateOf(it.value) })
        }
        val assignments = linkedMapOf<String, String>()

        fun assign(unitList: List<UnitData>, selectedIds: List<String>) {
            if (unitList.isEmpty()) return
            if (selectedIds.size == 1) {
                unitList.flatMap(UnitData::orderIds).forEach { assignments[it] = selectedIds.first() }
                return
            }
            if (unitList.size == 1) {
                val point = unitList.first().coordinate
                val target = point?.let {
                    selectedIds.mapNotNull { id -> vehicleCentroids[id]?.let { center -> Triple(id, center, vehicleOrder.getValue(id)) } }
                        .minWithOrNull(compareBy<Triple<String, Point, Int>>({ distance(it.second, point) }, { it.third }))?.first
                } ?: selectedIds.first()
                unitList.first().orderIds.forEach { assignments[it] = target }
                return
            }
            val located = unitList.filter { it.coordinate != null }
            if (located.size < 2) {
                balance(unitList, selectedIds, assignments)
                return
            }
            val meanLatitude = located.sumOf { it.coordinate!!.latitude } / located.size
            val xScale = cos(meanLatitude * Math.PI / 180)
            fun value(point: Point, axis: Int) = if (axis == 0) point.longitude * xScale else point.latitude
            val ranges = (0..1).map { axis ->
                val values = located.map { value(it.coordinate!!, axis) }
                values.max() - values.min()
            }
            val axis = if (ranges[0] >= ranges[1]) 0 else 1
            if (ranges[axis] == 0.0) {
                balance(unitList, selectedIds, assignments)
                return
            }
            val orderedVehicles = selectedIds.sortedWith { left, right ->
                val leftPoint = vehicleCentroids[left]
                val rightPoint = vehicleCentroids[right]
                when {
                    leftPoint != null && rightPoint != null -> compareValues(value(leftPoint, axis), value(rightPoint, axis)).takeIf { it != 0 }
                        ?: compareValues(vehicleOrder.getValue(left), vehicleOrder.getValue(right))
                    leftPoint != null -> -1
                    rightPoint != null -> 1
                    else -> compareValues(vehicleOrder.getValue(left), vehicleOrder.getValue(right))
                }
            }
            val leftIds = orderedVehicles.take(orderedVehicles.size / 2)
            val rightIds = orderedVehicles.drop(orderedVehicles.size / 2)
            val orderedLocated = located.sortedWith(compareBy<UnitData>({ value(it.coordinate!!, axis) }, { it.index }, { it.id }))
            val targetBoxes = orderedLocated.sumOf(UnitData::boxes) * leftIds.size / orderedVehicles.size
            var runningBoxes = 0.0
            var cut = 1
            var bestDifference = Double.POSITIVE_INFINITY
            for (index in 1 until orderedLocated.size) {
                runningBoxes += orderedLocated[index - 1].boxes
                val difference = kotlin.math.abs(runningBoxes - targetBoxes)
                if (difference < bestDifference) {
                    bestDifference = difference
                    cut = index
                }
            }
            val leftUnits = orderedLocated.take(cut).toMutableList()
            val rightUnits = orderedLocated.drop(cut).toMutableList()
            var leftBoxes = leftUnits.sumOf(UnitData::boxes)
            var rightBoxes = rightUnits.sumOf(UnitData::boxes)
            unitList.filter { it.coordinate == null }.sortedWith(compareByDescending<UnitData> { it.boxes }.thenBy { it.index }.thenBy { it.id }).forEach { unit ->
                if (leftBoxes / leftIds.size <= rightBoxes / rightIds.size) {
                    leftUnits += unit
                    leftBoxes += unit.boxes
                } else {
                    rightUnits += unit
                    rightBoxes += unit.boxes
                }
            }
            assign(leftUnits, leftIds)
            assign(rightUnits, rightIds)
        }

        assign(territoryUnits, vehicleIds)
        return dispatchMapper.createObjectNode().apply { assignments.forEach(::put) }
    }

    private fun balance(units: List<UnitData>, vehicleIds: List<String>, assignments: MutableMap<String, String>) {
        val loads = vehicleIds.mapIndexed { index, id -> Load(id, index) }.toMutableList()
        units.sortedWith(compareByDescending<UnitData> { it.boxes }.thenBy { it.index }.thenBy { it.id }).forEach { unit ->
            val target = loads.minWith(compareBy<Load>({ it.boxes }, { it.units }, { it.index }))
            unit.orderIds.forEach { assignments[it] = target.id }
            target.boxes += unit.boxes
            target.units += 1
        }
    }

    private fun mergeTerritories(units: List<UnitData>): List<UnitData> {
        val parents = units.indices.toMutableList()
        fun find(start: Int): Int {
            var index = start
            while (parents[index] != index) {
                parents[index] = parents[parents[index]]
                index = parents[index]
            }
            return index
        }
        fun unite(left: Int, right: Int) {
            val leftRoot = find(left)
            val rightRoot = find(right)
            if (leftRoot != rightRoot) parents[maxOf(leftRoot, rightRoot)] = minOf(leftRoot, rightRoot)
        }
        val firstByZone = mutableMapOf<String, Int>()
        units.forEachIndexed { index, unit -> unit.zoneIds.forEach { zone -> firstByZone.putIfAbsent(zone, index)?.let { unite(index, it) } } }
        return units.indices.groupBy(::find).values.map { indexes ->
            val members = indexes.map(units::get)
            val points = members.flatMap(UnitData::points)
            UnitData(
                id = members.first().id,
                index = members.first().index,
                orderIds = members.flatMap(UnitData::orderIds),
                boxes = members.sumOf(UnitData::boxes),
                points = points,
                coordinate = centroid(points),
                zoneIds = emptyList(),
            )
        }
    }

    @Suppress("ComplexCondition", "ReturnCount")
    private fun coordinateOf(order: ObjectNode): Point? {
        val coordinates = order["coordinates"] as? ArrayNode ?: return null
        if (coordinates.size() < 2 || !coordinates[0].isNumber || !coordinates[1].isNumber) return null
        val longitude = coordinates[0].doubleValue()
        val latitude = coordinates[1].doubleValue()
        return if (longitude.isFinite() && latitude.isFinite() && longitude in -180.0..180.0 && latitude in -90.0..90.0) Point(longitude, latitude) else null
    }

    private fun centroid(points: List<Point>): Point? = points.takeIf(List<Point>::isNotEmpty)?.let {
        Point(it.sumOf(Point::longitude) / it.size, it.sumOf(Point::latitude) / it.size)
    }

    private fun zones(order: ObjectNode): List<String> {
        val multiple = order["zoneIds"] as? ArrayNode
        if (multiple != null) return multiple.filter(JsonNode::isString).map(JsonNode::asString).filter(String::isNotEmpty)
        return order.text("zoneId")?.takeIf(String::isNotEmpty)?.let(::listOf).orEmpty()
    }

    private fun distance(left: Point, right: Point): Double =
        (left.longitude - right.longitude) * (left.longitude - right.longitude) +
            (left.latitude - right.latitude) * (left.latitude - right.latitude)

    private data class Point(val longitude: Double, val latitude: Double)
    private data class IndexedOrder(val value: ObjectNode, val index: Int)
    private data class UnitData(
        val id: String,
        val index: Int,
        val orderIds: List<String>,
        val boxes: Double,
        val points: List<Point>,
        val coordinate: Point?,
        val zoneIds: List<String>,
    )
    private data class Load(val id: String, val index: Int, var boxes: Double = 0.0, var units: Int = 0)

    private fun invalid(message: String): Nothing = throw DispatchException(400, "INVALID_CALCULATION", message)
}

private fun ObjectNode.text(name: String): String? = get(name)?.takeIf(JsonNode::isString)?.asString()
private fun JsonNode?.strings(): List<String>? = (this as? ArrayNode)?.takeIf { it.all(JsonNode::isString) }?.toList()?.map { it.asString() }
