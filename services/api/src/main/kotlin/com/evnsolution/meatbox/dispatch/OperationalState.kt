// Schema-1 checkpoint compatibility keeps its validators and exact legacy field mappings co-located.
@file:Suppress("MaxLineLength", "TooManyFunctions")

package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.text.Normalizer
import kotlin.math.abs

private const val SEOUL_UTC_OFFSET_HOURS = 9
private const val MIN_READABLE_NAME_LENGTH = 4
private const val BAD_REQUEST_STATUS = 400
private const val CONFLICT_STATUS = 409

@Suppress("LargeClass")
class OperationalState(
    day: ObjectNode,
    private val sourceId: String,
    private val clock: () -> Long,
    checkpoint: ObjectNode? = null,
) {
    private val sourceDay = copyObject(day)
    private val date: String
    private val presentationContentVersion: Int
    private val vehicles = linkedMapOf<String, ObjectNode>()
    private val orders = linkedMapOf<String, ObjectNode>()
    private val routes = linkedMapOf<String, MutableList<String>>()
    private val states = linkedMapOf<String, ObjectNode>()
    private val initialRoutes = linkedMapOf<String, List<String>>()
    private val initialAssignments = linkedMapOf<String, String>()
    private val initialStates = linkedMapOf<String, ObjectNode>()
    private val initialLocations = linkedMapOf<String, ObjectNode>()
    private val initialTips = linkedMapOf<String, JsonNode>()
    private val events = mutableListOf<ObjectNode>()
    private val notices = mutableListOf<ObjectNode>()
    private val defaultVehicleId: String?
    private val defaultStopId: String?
    private var mutableRevision = 0L
    private var stateTimestamp: Long
    private var nextEventId = 1L
    private var nextNoticeId = 1L

    val revision: Long get() = mutableRevision

    init {
        validateDay(sourceDay)
        date = sourceDay["date"].asString()
        if (!validDate(date)) invalid("배차 날짜를 확인해 주세요.")
        presentationContentVersion = checkpoint?.let { saved ->
            if (saved.has("presentationContentVersion")) saved["presentationContentVersion"].exactInt()
                ?: invalid("저장된 운행 상태를 확인해 주세요.")
            else 1
        } ?: 0
        if (presentationContentVersion !in 0..1) invalid("저장된 운행 상태를 확인해 주세요.")

        createDispatchFleet(sourceDay).forEach { source ->
            val vehicle = copyObject(source).apply {
                put("live", true)
                put("operationsSource", "local")
            }
            val id = vehicle["id"].asString()
            vehicles[id] = vehicle
            routes[id] = mutableListOf()
            initialLocations[id] = copyObject(vehicle["location"] as ObjectNode)
        }
        (sourceDay["orders"] as ArrayNode).forEach { value -> addOrder(value as ObjectNode) }
        routes.values.forEach { route -> route.sortWith(compareBy { orders.getValue(it)["sequence"]?.doubleValue() ?: 0.0 }) }
        routes.forEach { (id, route) -> initialRoutes[id] = route.toList() }

        defaultVehicleId = selectDefaultVehicle()
        defaultStopId = defaultVehicleId?.let { vehicleId ->
            routes.getValue(vehicleId).firstOrNull { id ->
                val order = orders.getValue(id)
                hasCoordinates(order) && readableName(order["name"])
            } ?: routes.getValue(vehicleId).firstOrNull()
        }
        vehicles.forEach { (id, vehicle) ->
            val state = initialVehicleState(vehicle)
            states[id] = state
            initialStates[id] = copyObject(state)
        }
        orders.forEach { (id, order) ->
            initialAssignments[id] = order["vehicleId"].asString()
            initialTips[id] = copyNode(order["tip"])
        }
        stateTimestamp = clock()
        checkpoint?.let(::restoreCheckpoint)
    }

    fun snapshot(): ObjectNode {
        val selectedState = defaultVehicleId?.let(::stateFor)
        val result = dispatchMapper.createObjectNode()
        result.set("sourceData", dispatchMapper.createObjectNode().apply {
            put("date", date)
            put("sourceId", sourceId)
            setCopy("summary", sourceDay["summary"])
            putNullable("defaultVehicleId", defaultVehicleId)
            putNullable("defaultStopId", defaultStopId)
        })
        result.put("revision", mutableRevision)
        result.put("simTime", stateTimestamp)
        result.put("simClock", clockText(stateTimestamp))
        result.set("fleetVehicles", array(vehicles.values.map(::copyObject)))
        result.set("fleetDeliveries", array(vehicles.keys.flatMap(::deliveriesFor)))
        result.set("vehicleStates", dispatchMapper.createObjectNode().apply {
            vehicles.keys.forEach { id -> set(id, stateFor(id)) }
        })
        result.setCopy("vehicle", defaultVehicleId?.let(vehicles::get))
        result.set("deliveries", array(defaultVehicleId?.let(::deliveriesFor).orEmpty()))
        result.setCopy("truck", selectedState?.get("truck"))
        result.put("phase", selectedState?.get("phase")?.asString() ?: "idle")
        result.setCopy("kpi", selectedState?.get("kpi") ?: dispatchMapper.createObjectNode())
        result.putNullable("customerStopId", defaultStopId)
        result.putNullable("scenarioPreset", selectedState?.get("scenarioPreset")?.takeUnless(JsonNode::isNull)?.asString())
        result.putNullable("scenarioStopId", selectedState?.get("scenarioStopId")?.takeUnless(JsonNode::isNull)?.asString())
        result.put("speed", 0)
        result.putNull("device")
        result.putArray("incidents")
        result.putNull("nextStep")
        result.set("events", array(events.asReversed().map(::copyObject)))
        result.set("notifications", array(notices.map(::publicNotice)))
        return result
    }

    fun exportCheckpoint(): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("schemaVersion", 1)
        put("presentationContentVersion", presentationContentVersion)
        put("date", date)
        put("sourceId", sourceId)
        put("revision", mutableRevision)
        put("stateTimestamp", stateTimestamp)
        put("nextEventId", nextEventId)
        put("nextNoticeId", nextNoticeId)
        set("routes", changedRoutes())
        set("orders", changedOrders())
        set("states", changedStates())
        set("events", array(events.map { event -> copyObject(event).apply { remove(listOf("message", "time")) } }))
        set("notices", array(notices.map(::savedNotice)))
    }

    fun command(command: ObjectNode): ObjectNode {
        val expectedRevision = command["expectedRevision"].exactLong()
            ?.takeIf { it >= 0 } ?: invalid("현재 상태 revision이 필요합니다.")
        if (expectedRevision != mutableRevision) conflict("운행 상태가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.")
        val result = when (command["type"]?.takeIf(JsonNode::isString)?.asString()) {
            "set_route_order" -> reorder(command)
            "reassign" -> reassign(command)
            else -> invalid("지원하지 않는 운행 명령입니다.")
        }
        mutableRevision += 1
        return dispatchMapper.createObjectNode().apply {
            set("state", snapshot())
            set("result", result)
        }
    }

    private fun addOrder(source: ObjectNode) {
        val defaults = if (presentationContentVersion == 1) presentationOrderContent(source) else dispatchMapper.createObjectNode()
        val order = copyObject(defaults).apply { setAll(copyObject(source)) }
        val id = order["id"].asString()
        val vehicleId = source["groupId"].asString()
        order.setCopy("originalGroupId", source["groupId"])
        order.put("vehicleId", vehicleId)
        order.put("status", "pending")
        order.setCopy("customerRequests", nullish(source["customerRequests"], defaults["customerRequests"]))
        order.setCopy("items", nullish(source["items"], defaults["items"]) ?: dispatchMapper.createArrayNode())
        order.setCopy("eta", nullish(source["eta"], defaults["eta"]))
        order.setCopy("tip", nullish(source["tip"], defaults["tip"]))
        order.setCopy("transportConditions", nullish(source["transportConditions"], defaults["transportConditions"]))
        order.putNull("customerStage")
        order.putNull("arrivedAt")
        order.putNull("completedAt")
        orders[id] = order
        routes.getValue(vehicleId).add(id)
    }

    private fun selectDefaultVehicle(): String? {
        val candidates = vehicles.keys.filter { routes.getValue(it).isNotEmpty() }
        val readable = candidates.filter { vehicleId ->
            val routeOrders = routes.getValue(vehicleId).map(orders::getValue)
            routeOrders.all(::hasCoordinates) && routeOrders.count { readableName(it["name"]) } >= (routeOrders.size + 1) / 2
        }
        return (readable.ifEmpty { candidates }).minWithOrNull(compareBy<String>({ vehicleId ->
            val route = routes.getValue(vehicleId)
            abs(route.size - TARGET_ROUTE_STOPS) * ROUTE_STOP_WEIGHT +
                abs(route.sumOf { orders.getValue(it)["boxes"].doubleValue() } - TARGET_ROUTE_BOXES)
        }, { it })) ?: vehicles.keys.firstOrNull()
    }

    private fun deliveriesFor(vehicleId: String): List<ObjectNode> =
        routes.getValue(vehicleId).mapIndexed { index, id -> delivery(orders.getValue(id), index) }

    private fun delivery(order: ObjectNode, index: Int): ObjectNode {
        val result = copyObject(order).apply { remove("customerStage") }
        val status = order["status"].asString()
        val customerStage = order["customerStage"]?.takeUnless(JsonNode::isNull)?.asString()
        result.put("sequence", index + 1)
        result.put("driver", vehicles.getValue(order["vehicleId"].asString())["driver"].asString())
        result.put("statusTone", when (status) { "done" -> "green"; "current" -> "blue"; else -> "neutral" })
        result.set("customerStatus", customerStatus(status, customerStage))
        result.put("customerStatusTone", when (status) { "done" -> "green"; "current" -> "blue"; "skipped" -> "amber"; else -> "neutral" })
        result.put("ordered", true)
        result.putNull("officialEta")
        result.putNull("calculatedEta")
        result.putTimeOrNull("arrivedAt", order["arrivedAt"])
        result.putTimeOrNull("completedAt", order["completedAt"])
        val id = order["id"].asString()
        result.set("timeline", array(events.filter { referencesOrder(it, id) }.map { event ->
            dispatchMapper.createObjectNode().apply {
                val prefix = "${order["name"]?.asString().orEmpty()} "
                put("label", event["message"].asString().replaceFirst(prefix, ""))
                put("time", event["time"].asString())
                put("state", if (status == "done") "done" else "current")
            }
        }))
        result.putNull("preciseTimeText")
        result.putNull("customerWindowText")
        result.putNull("customerWindowStart")
        result.putNull("customerWindowEnd")
        result.set("vehicle", copyObject(vehicles.getValue(order["vehicleId"].asString())))
        result.set("notices", array(notices.filter { referencesOrder(it, id) }.map(::publicNotice)))
        val tip = order["tip"]
        if (tip is ObjectNode) {
            result.set("tip", copyObject(tip).apply { putTimeOrNull("updatedAt", tip["updatedAt"]) })
        } else {
            result.putNull("tip")
        }
        return result
    }

    private fun stateFor(vehicleId: String): ObjectNode = copyObject(states.getValue(vehicleId)).apply {
        set("kpi", kpiFor(vehicleId))
    }

    private fun kpiFor(vehicleId: String): ObjectNode {
        val routeOrders = routes.getValue(vehicleId).map(orders::getValue)
        val done = routeOrders.filter { it["status"].asString() == "done" }
        return dispatchMapper.createObjectNode().apply {
            put("stopsTotal", routeOrders.size)
            put("stopsDone", done.size)
            put("stopsRemaining", routeOrders.count { it["status"].asString() != "done" })
            putJsNumber("boxesTotal", routeOrders.sumOf { it["boxes"].doubleValue() })
            putJsNumber("boxesDelivered", done.sumOf { it["boxes"].doubleValue() })
            putJsNumber("boxesRemaining", routeOrders.filter { it["status"].asString() != "done" }.sumOf { it["boxes"].doubleValue() })
        }
    }

    private fun reorder(command: ObjectNode): ObjectNode {
        val vehicleId = requireVehicle(command.string("vehicleId"))
        val current = routes.getValue(vehicleId)
        val requested = command.stringArray("order")
        validateRequestedOrder(requested, current)
        val expectedOrder = command.stringArray("expectedOrder")
        val expectedStatuses = command.stringArray("expectedStatuses")
        val expectedPhase = command.string("expectedPhase")
        validateExpectedRoute(expectedOrder, expectedStatuses, expectedPhase, current.size)
        val actualStatuses = current.map { orders.getValue(it)["status"].asString() }
        val routeChanged = expectedOrder != current || expectedStatuses != actualStatuses
        if (expectedPhase != states.getValue(vehicleId)["phase"].asString() || routeChanged) {
            conflict("배송 상태가 바뀌었습니다. 다시 확인해 주세요.")
        }
        validateBundleOrder(requested, current)
        validateProtectedPositions(requested, current)
        if (requested == current) invalid("변경된 배송 순서가 없습니다.")
        routes[vehicleId] = requested.toMutableList()
        record("route_order", vehicleId, null, "${vehicles.getValue(vehicleId)["driver"].asString()} 배송 순서 변경")
        return dispatchMapper.createObjectNode().apply {
            put("type", "set_route_order")
            put("vehicleId", vehicleId)
            set("order", stringArray(requested))
        }
    }

    private fun validateRequestedOrder(requested: List<String>, current: List<String>) {
        val invalidMembership = requested.any { it !in current }
        if (requested.size != current.size || requested.toSet().size != current.size || invalidMembership) {
            invalid("배송 순서를 확인해 주세요.")
        }
    }

    private fun validateExpectedRoute(
        expectedOrder: List<String>,
        expectedStatuses: List<String>,
        expectedPhase: String?,
        routeSize: Int,
    ) {
        val invalidStatuses = expectedStatuses.any { it !in STATUSES }
        val invalidSizes = expectedOrder.size != routeSize || expectedStatuses.size != routeSize
        if (invalidSizes || invalidStatuses || expectedPhase !in PHASES) {
            invalid("배송 순서 기준 상태를 확인해 주세요.")
        }
    }

    private fun validateBundleOrder(requested: List<String>, current: List<String>) {
        val positions = requested.withIndex().associate { (index, id) -> id to index }
        current.groupBy { destinationKey(orders.getValue(it)) }.values.forEach { ids ->
            val indexes = ids.map(positions::getValue).sorted()
            val contiguous = indexes.zipWithNext().all { (first, second) -> second == first + 1 }
            val sameOrder = requested.filter(ids::contains) == ids
            if (!contiguous || !sameOrder) invalid("같은 배송지의 주문 순서는 서로 붙어 있어야 합니다.")
        }
    }

    private fun validateProtectedPositions(requested: List<String>, current: List<String>) {
        val movedProtectedStop = current.indices.any { index ->
            orders.getValue(current[index])["status"].asString() != "pending" && requested[index] != current[index]
        }
        if (movedProtectedStop) invalid("현재, 완료 또는 보류 배송지는 순서를 바꿀 수 없습니다.")
    }

    private fun reassign(command: ObjectNode): ObjectNode {
        val targetVehicleId = requireVehicle(command["targetVehicleId"]?.takeIf(JsonNode::isString)?.asString()
            ?: command["targetGroupId"]?.takeIf(JsonNode::isString)?.asString())
        val requestedIds = command.stringArray("orderIds")
        if (requestedIds.isEmpty()) invalid("재배정할 주문을 선택해 주세요.")
        val expanded = linkedMapOf<String, ObjectNode>()
        requestedIds.distinct().forEach { id ->
            val order = requireStop(id)
            bundleFor(order).forEach { member -> expanded.putIfAbsent(member["id"].asString(), member) }
        }
        val moved = expanded.values.toList()
        if (moved.any { it["vehicleId"].asString() == targetVehicleId }) invalid("선택한 주문 중 대상 차량에 이미 배차된 주문이 있습니다.")
        if (moved.any { it["status"].asString() in PROTECTED_STATUSES }) invalid("현재 또는 완료 배송지는 재배정할 수 없습니다.")
        moved.forEach { order ->
            val id = order["id"].asString()
            val previousVehicleId = order["vehicleId"].asString()
            routes.getValue(previousVehicleId).remove(id)
            order.put("vehicleId", targetVehicleId)
            order.putNull("customerStage")
            if (states.getValue(previousVehicleId)["scenarioStopId"]?.asString() == id) {
                states[previousVehicleId] = initialVehicleState(vehicles.getValue(previousVehicleId))
            }
        }
        val ids = moved.map { it["id"].asString() }
        routes.getValue(targetVehicleId).addAll(ids)
        if (states.getValue(targetVehicleId)["phase"].asString() == "done") {
            states[targetVehicleId] = initialVehicleState(vehicles.getValue(targetVehicleId))
        }
        record("reassign", targetVehicleId, ids.singleOrNull(), "배차 변경")
        return dispatchMapper.createObjectNode().apply {
            put("type", "reassign")
            put("targetVehicleId", targetVehicleId)
            put("changedCount", ids.size)
            putJsNumber("changedBoxes", moved.sumOf { it["boxes"].doubleValue() })
            put("persisted", false)
        }
    }

    private fun changedRoutes(): ObjectNode = dispatchMapper.createObjectNode().apply {
        routes.forEach { (vehicleId, route) ->
            if (route != initialRoutes.getValue(vehicleId)) set(vehicleId, stringArray(route))
        }
    }

    private fun changedOrders(): ObjectNode = dispatchMapper.createObjectNode().apply {
        orders.forEach { (id, order) ->
            val change = dispatchMapper.createObjectNode()
            if (order["vehicleId"].asString() != initialAssignments.getValue(id)) change.setCopy("vehicleId", order["vehicleId"])
            if (order["status"].asString() != "pending") change.setCopy("status", order["status"])
            if (!order["customerStage"].isNull) change.setCopy("customerStage", order["customerStage"])
            if (order["tip"] != initialTips.getValue(id)) change.setCopy("tip", order["tip"])
            if (!order["arrivedAt"].isNull) change.setCopy("arrivedAt", order["arrivedAt"])
            if (!order["completedAt"].isNull) change.setCopy("completedAt", order["completedAt"])
            if (!change.isEmpty) set(id, change)
        }
    }

    private fun changedStates(): ObjectNode = dispatchMapper.createObjectNode().apply {
        states.forEach { (vehicleId, state) ->
            val location = vehicles.getValue(vehicleId)["location"] as ObjectNode
            if (state != initialStates.getValue(vehicleId) || location != initialLocations.getValue(vehicleId)) {
                set(vehicleId, copyObject(state).apply { set("vehicleLocation", copyObject(location)) })
            }
        }
    }

    private fun savedNotice(notice: ObjectNode): ObjectNode {
        if (notice.has("_template")) return dispatchMapper.createObjectNode().apply {
            setCopy("id", notice["id"])
            setCopy("ts", notice["ts"])
            setCopy("stopId", notice["stopId"])
            setCopy("orderIds", notice["orderIds"])
            setCopy("template", notice["_template"])
        }
        return publicNotice(notice).apply { remove(listOf("time", "clock")) }
    }

    private fun restoreCheckpoint(saved: ObjectNode) {
        validateCheckpointRoot(saved)
        val restoredRoutes = initialRoutes.mapValuesTo(linkedMapOf()) { it.value.toMutableList() }
        (saved["routes"] as ObjectNode).properties().forEach { (vehicleId, value) ->
            val route = value.stringValuesOrNull() ?: invalid("저장된 배차 순서를 확인해 주세요.")
            if (vehicleId !in vehicles || route.toSet().size != route.size || route.any { it !in orders }) {
                invalid("저장된 배차 순서를 확인해 주세요.")
            }
            restoredRoutes[vehicleId] = route.toMutableList()
        }
        val restoredOrders = linkedMapOf<String, ObjectNode>()
        (saved["orders"] as ObjectNode).properties().forEach { (id, value) ->
            val change = value as? ObjectNode
            if (id !in orders || change == null || change.properties().any { it.key !in ORDER_CHANGE_KEYS }) {
                invalid("저장된 주문 상태를 확인해 주세요.")
            }
            val vehicleId = validateOrderChange(id, change)
            restoredOrders[id] = copyObject(change).apply { put("vehicleId", vehicleId) }
        }
        validateRouteMembership(restoredRoutes, restoredOrders)
        normalizeRestoredBundles(restoredRoutes, restoredOrders)
        val restoredStates = initialStates.mapValuesTo(linkedMapOf()) { copyObject(it.value) }
        restoreStates(saved["states"] as ObjectNode, restoredRoutes, restoredOrders, restoredStates)
        val restoredEvents = (saved["events"] as ArrayNode).toList().map { restoreEvent(it, restoredRoutes, restoredOrders) }
        val restoredNotices = (saved["notices"] as ArrayNode).toList().map { restoreNotice(it, restoredRoutes, restoredOrders) }

        routes.clear(); routes.putAll(restoredRoutes)
        restoredOrders.forEach { (id, change) -> orders.getValue(id).setAll(copyObject(change)) }
        states.clear(); states.putAll(restoredStates)
        events.addAll(restoredEvents)
        notices.addAll(restoredNotices)
        mutableRevision = saved["revision"].longValue()
        stateTimestamp = saved["stateTimestamp"].longValue()
        nextEventId = saved["nextEventId"].longValue()
        nextNoticeId = saved["nextNoticeId"].longValue()
    }

    private fun validateCheckpointRoot(saved: ObjectNode) {
        val validIdentity = saved["schemaVersion"].exactInt() == 1 && saved["date"]?.asString() == date &&
            saved["sourceId"]?.takeIf(JsonNode::isString)?.asString() == sourceId
        if (!validIdentity || !validCheckpointCounters(saved) || !validCheckpointCollections(saved)) {
            invalid("저장된 운행 상태를 확인해 주세요.")
        }
    }

    private fun validCheckpointCounters(saved: ObjectNode): Boolean {
        val revisionValid = saved["revision"].exactLong()?.let { it >= 0 } == true
        val sequenceValid = saved["nextEventId"].exactLong()?.let { it >= 1 } == true &&
            saved["nextNoticeId"].exactLong()?.let { it >= 1 } == true
        return revisionValid && saved["stateTimestamp"].finiteNumber() && sequenceValid
    }

    private fun validCheckpointCollections(saved: ObjectNode): Boolean {
        val routeDataValid = saved["routes"] is ObjectNode && saved["orders"] is ObjectNode &&
            saved["states"] is ObjectNode
        val historyValid = saved["events"] is ArrayNode && saved["notices"] is ArrayNode
        return routeDataValid && historyValid
    }

    private fun validateOrderChange(id: String, change: ObjectNode): String {
        val savedVehicleId = change["vehicleId"]
        val vehicleId = when {
            savedVehicleId == null || savedVehicleId.isNull -> initialAssignments.getValue(id)
            savedVehicleId.isString -> savedVehicleId.asString()
            else -> invalid("저장된 주문 상태를 확인해 주세요.")
        }
        val validChange = vehicleId in vehicles && validSavedStatus(change) && validSavedStage(change)
        val validDetails = validSavedTimestamps(change) && validSavedTip(change["tip"])
        if (!validChange || !validDetails) invalid("저장된 주문 상태를 확인해 주세요.")
        return vehicleId
    }

    private fun validSavedStatus(change: ObjectNode): Boolean {
        val status = change["status"] ?: return true
        return status.isString && status.asString() in STATUSES
    }

    private fun validSavedStage(change: ObjectNode): Boolean {
        val stage = change["customerStage"] ?: return true
        return stage.isNull || stage.isString && stage.asString() in CUSTOMER_STAGES
    }

    private fun validSavedTimestamps(change: ObjectNode): Boolean =
        (change["arrivedAt"] == null || change["arrivedAt"].finiteNumber()) &&
            (change["completedAt"] == null || change["completedAt"].finiteNumber())

    private fun validSavedTip(tip: JsonNode?): Boolean = when {
        tip == null -> true
        tip !is ObjectNode -> false
        else -> tip["body"]?.isString == true && tip["author"]?.isString == true && tip["updatedAt"].finiteNumber()
    }

    private fun validateRouteMembership(
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ) {
        val allIds = restoredRoutes.values.flatten()
        if (allIds.size != orders.size || allIds.toSet().size != orders.size || allIds.any { it !in orders }) {
            invalid("저장된 배차 구성을 확인해 주세요.")
        }
        restoredRoutes.forEach { (vehicleId, route) ->
            if (route.any { restoredVehicleId(it, restoredOrders) != vehicleId }) invalid("저장된 배차 구성을 확인해 주세요.")
        }
    }

    // These functions validate and normalize one schema-1 record atomically so corrupt legacy data is never half-restored.
    @Suppress("CyclomaticComplexMethod")
    private fun normalizeRestoredBundles(
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: MutableMap<String, ObjectNode>,
    ) {
        val seen = mutableSetOf<String>()
        restoredRoutes.values.flatten().forEach { id ->
            val vehicleId = restoredVehicleId(id, restoredOrders)
            val bundleKey = "$vehicleId\u0000${destinationKey(orders.getValue(id))}"
            if (!seen.add(bundleKey)) return@forEach
            val bundleIds = restoredBundleIds(id, restoredRoutes, restoredOrders)
            val bundle = bundleIds.map { effectiveOrder(it, restoredOrders) }
            val status = listOf("done", "current", "skipped", "pending").first { candidate ->
                bundle.any { it["status"].asString() == candidate }
            }
            val arrivedAt = bundle.mapNotNull { it["arrivedAt"].finiteDouble() }.maxOrNull()
            val completedAt = bundle.mapNotNull { it["completedAt"].finiteDouble() }.maxOrNull()
            val stage = restoredBundleStage(bundle, status)
            bundleIds.forEach { bundleId ->
                restoredOrders[bundleId] = normalizedBundleChange(
                    bundleId,
                    restoredOrders,
                    status,
                    stage,
                    arrivedAt,
                    completedAt,
                )
            }
        }
    }

    private fun restoredBundleStage(bundle: List<ObjectNode>, status: String): String? = when (status) {
        "done" -> "completed"
        "current" -> if (bundle.any { order ->
            order["customerStage"]?.asString() == "arrived" || order["arrivedAt"].finiteNumber()
        }) {
            "arrived"
        } else {
            "shipping"
        }
        "pending" -> when {
            bundle.any { it["customerStage"]?.asString() == "ready" } -> "ready"
            bundle.any { it["customerStage"]?.asString() == "picking" } -> "picking"
            else -> null
        }
        else -> null
    }

    private fun normalizedBundleChange(
        bundleId: String,
        restoredOrders: Map<String, ObjectNode>,
        status: String,
        stage: String?,
        arrivedAt: Double?,
        completedAt: Double?,
    ): ObjectNode {
        val current = effectiveOrder(bundleId, restoredOrders)
        return copyObject(restoredOrders[bundleId] ?: dispatchMapper.createObjectNode()).apply {
            put("vehicleId", current["vehicleId"].asString())
            put("status", status)
            putNullable("customerStage", stage)
            if (arrivedAt != null) putJsNumber("arrivedAt", current["arrivedAt"].finiteDouble() ?: arrivedAt)
            if (completedAt != null) putJsNumber("completedAt", current["completedAt"].finiteDouble() ?: completedAt)
        }
    }

    @Suppress("CyclomaticComplexMethod", "ComplexCondition")
    private fun restoreStates(
        savedStates: ObjectNode,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
        restoredStates: MutableMap<String, ObjectNode>,
    ) {
        savedStates.properties().forEach { (vehicleId, value) ->
            val savedState = value as? ObjectNode
            val truck = savedState?.get("truck") as? ObjectNode
            val location = savedState?.get("vehicleLocation") as? ObjectNode
            val coordinates = location?.get("coordinates")
            val preset = savedState?.get("scenarioPreset")
            val stop = savedState?.get("scenarioStopId")
            val valid = vehicleId in vehicles && savedState != null && truck != null && location != null &&
                savedState["phase"]?.asString() in PHASES &&
                (preset?.isNull == true || preset?.isString == true && preset.asString() in SCENARIOS) &&
                (stop?.isNull == true || stop?.isString == true && stop.asString() in orders) &&
                truck["lat"].finiteNumber() && truck["lng"].finiteNumber() && coordinates is ArrayNode &&
                coordinates.size() == 2 && coordinates.all { it.finiteNumber() } && location["source"]?.asString() == "demo"
            if (!valid) invalid("저장된 차량 상태를 확인해 주세요.")
            val stopId = stop.takeUnless(JsonNode::isNull)?.asString()
            if (stopId != null && restoredVehicleId(stopId, restoredOrders) != vehicleId) invalid("저장된 차량 상태를 확인해 주세요.")
            val state = copyObject(savedState).apply { remove("vehicleLocation") }
            state.putNullable("scenarioStopId", canonicalStopId(stopId, vehicleId, false, restoredRoutes, restoredOrders))
            val restoredTruck = state["truck"] as ObjectNode
            listOf("fromId", "toId", "atStopId").forEach { key ->
                restoredTruck.putNullable(key, canonicalStopId(restoredTruck[key]?.takeUnless(JsonNode::isNull)?.asString(), vehicleId, true, restoredRoutes, restoredOrders))
            }
            val routeOrders = restoredRoutes.getValue(vehicleId).map { effectiveOrder(it, restoredOrders) }
            if (routeOrders.any { it["status"].asString() == "current" }) state.put("phase", "delivering")
            else if (routeOrders.isNotEmpty() && routeOrders.all { it["status"].asString() == "done" }) state.put("phase", "done")
            restoredStates[vehicleId] = state
            vehicles.getValue(vehicleId).set("location", copyObject(location))
        }
    }

    @Suppress("CyclomaticComplexMethod", "ComplexCondition")
    private fun restoreEvent(
        value: JsonNode,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ): ObjectNode {
        val event = value as? ObjectNode
        val vehicleId = event?.get("vehicleId")?.takeIf(JsonNode::isString)?.asString()
        val stopValue = event?.get("stopId")
        val idsValue = event?.get("orderIds")
        val valid = event != null && event["id"].exactLong() != null && event["ts"].finiteNumber() &&
            event["action"]?.isString == true && event["type"]?.isString == true && vehicleId in vehicles &&
            (stopValue == null || stopValue.isString && stopValue.asString() in orders) &&
            (idsValue == null || idsValue.stringValuesOrNull()?.let { it.toSet().size == it.size && it.all(orders::containsKey) } == true)
        if (!valid) invalid("저장된 사건 이력을 확인해 주세요.")
        var stopId = stopValue?.asString()
        var orderIds = idsValue?.stringValuesOrNull()
        if (orderIds != null) orderIds = exactBundleOrderIds(stopId, orderIds, "저장된 사건 이력을 확인해 주세요.", restoredRoutes, restoredOrders)
        else if (event["action"].asString() in PHYSICAL_ACTIONS && stopId != null) orderIds = restoredBundleIds(stopId, restoredRoutes, restoredOrders)
        if (orderIds != null) stopId = orderIds.first()
        val result = copyObject(event).apply { remove(listOf("id", "ts", "vehicleId", "action", "type", "orderIds", "stopId")) }
        result.setCopy("id", event["id"])
        result.setCopy("ts", event["ts"])
        result.put("time", clockText(event["ts"].longValue()))
        result.put("vehicleId", vehicleId)
        if (stopId != null) result.put("stopId", stopId)
        result.put("action", event["action"].asString())
        result.put("type", event["type"].asString())
        result.put("message", eventMessage(event["action"].asString(), vehicleId!!, stopId, event))
        copyObject(event).properties().filter { it.key !in EVENT_BASE_KEYS }.forEach { (key, metadata) -> result.setCopy(key, metadata) }
        if (orderIds != null) result.set("orderIds", stringArray(orderIds))
        return result
    }

    @Suppress("CyclomaticComplexMethod", "ComplexCondition")
    private fun restoreNotice(
        value: JsonNode,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ): ObjectNode {
        val notice = value as? ObjectNode
        val stopValue = notice?.get("stopId")
        val idsValue = notice?.get("orderIds")
        val valid = notice != null && notice["id"].exactLong() != null && notice["ts"].finiteNumber() &&
            stopValue?.isString == true && stopValue.asString() in orders &&
            (idsValue == null || idsValue.stringValuesOrNull()?.let { it.toSet().size == it.size && it.all(orders::containsKey) } == true)
        if (!valid) invalid("저장된 고객 알림을 확인해 주세요.")
        var stopId = stopValue.asString()
        var orderIds = idsValue?.stringValuesOrNull()
        if (orderIds != null) orderIds = exactBundleOrderIds(stopId, orderIds, "저장된 고객 알림을 확인해 주세요.", restoredRoutes, restoredOrders)
        else if (notice.has("template")) orderIds = restoredBundleIds(stopId, restoredRoutes, restoredOrders)
        if (orderIds != null) stopId = orderIds.first()
        val template = notice["template"]?.takeIf(JsonNode::isString)?.asString()
        if (template != null) {
            if (template !in SCENARIOS) invalid("저장된 고객 알림을 확인해 주세요.")
            val (title, body) = scenarioNotice(orders.getValue(stopId), template)
            return dispatchMapper.createObjectNode().apply {
                setCopy("id", notice["id"]); setCopy("ts", notice["ts"])
                put("time", clockText(notice["ts"].longValue())); put("clock", clockText(notice["ts"].longValue()))
                put("stopId", stopId); set("orderIds", stringArray(orderIds.orEmpty()))
                put("title", title); put("body", body); put("kind", template)
                put("channel", "고객 팝업"); put("status", "기록"); put("author", "운영자"); put("_template", template)
            }
        }
        if (listOf("title", "body", "kind", "status").any { notice[it]?.isString != true }) invalid("저장된 고객 알림을 확인해 주세요.")
        return dispatchMapper.createObjectNode().apply {
            setCopy("id", notice["id"]); setCopy("ts", notice["ts"])
            put("time", clockText(notice["ts"].longValue())); put("clock", clockText(notice["ts"].longValue()))
            put("stopId", stopId); if (orderIds != null) set("orderIds", stringArray(orderIds))
            listOf("title", "body", "kind", "channel", "status", "author").forEach { key -> setCopy(key, notice[key]) }
        }
    }

    private fun exactBundleOrderIds(
        stopId: String?,
        orderIds: List<String>,
        message: String,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ): List<String> {
        if (stopId !in orders) invalid(message)
        val expected = restoredBundleIds(stopId!!, restoredRoutes, restoredOrders)
        if (orderIds.size != expected.size || orderIds.toSet().size != orderIds.size || expected.any { it !in orderIds }) invalid(message)
        return expected
    }

    private fun canonicalStopId(
        stopId: String?,
        vehicleId: String?,
        preserveNonStop: Boolean,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ): String? = when {
        stopId == null -> null
        stopId !in orders && preserveNonStop -> stopId
        stopId !in orders -> invalid("저장된 차량 상태를 확인해 주세요.")
        vehicleId != null && restoredVehicleId(stopId, restoredOrders) != vehicleId ->
            invalid("저장된 차량 상태를 확인해 주세요.")
        else -> restoredBundleIds(stopId, restoredRoutes, restoredOrders).first()
    }

    private fun restoredBundleIds(
        stopId: String,
        restoredRoutes: Map<String, List<String>>,
        restoredOrders: Map<String, ObjectNode>,
    ): List<String> {
        val vehicleId = restoredVehicleId(stopId, restoredOrders)
        val key = destinationKey(orders.getValue(stopId))
        return restoredRoutes.getValue(vehicleId).filter { destinationKey(orders.getValue(it)) == key }
    }

    private fun restoredVehicleId(id: String, restoredOrders: Map<String, ObjectNode>): String =
        restoredOrders[id]?.get("vehicleId")?.asString() ?: initialAssignments.getValue(id)

    private fun effectiveOrder(id: String, restoredOrders: Map<String, ObjectNode>): ObjectNode =
        copyObject(orders.getValue(id)).apply {
            restoredOrders[id]?.let { setAll(copyObject(it)) }
            put("vehicleId", restoredVehicleId(id, restoredOrders))
        }

    private fun bundleFor(order: ObjectNode): List<ObjectNode> {
        val key = destinationKey(order)
        return routes.getValue(order["vehicleId"].asString()).map(orders::getValue).filter { destinationKey(it) == key }
    }

    private fun record(action: String, vehicleId: String, stopId: String?, message: String) {
        stateTimestamp = clock()
        events += dispatchMapper.createObjectNode().apply {
            put("id", nextEventId++)
            put("ts", stateTimestamp)
            put("time", clockText(stateTimestamp))
            put("vehicleId", vehicleId)
            if (stopId != null) put("stopId", stopId)
            put("action", action)
            put("type", "driver")
            put("message", message)
        }
    }

    private fun eventMessage(action: String, vehicleId: String, stopId: String?, event: ObjectNode): String {
        val order = stopId?.let(orders::get)
        val scenarioLabel = SCENARIO_LABELS[action]
        return when {
            order != null && scenarioLabel != null -> "${order["name"].asString()} $scenarioLabel"
            order != null && action == "toggle_skip" ->
                "${order["name"].asString()} ${if (event["status"]?.asString() == "skipped") "배송 보류" else "배송 보류 해제"}"
            order != null && action == "delivery_tip" -> "${order["name"].asString()} 배송 팁 수정"
            order != null && action == "customer_notice" -> "${order["name"].asString()} 고객 안내 기록"
            action == "route_order" -> "${vehicles[vehicleId]?.get("driver")?.asString() ?: "배송원"} 배송 순서 변경"
            action == "reassign" -> "배차 변경"
            else -> "배송 상태 변경"
        }
    }

    // Version-1 presentation fields reproduce the legacy saved snapshot exactly.
    @Suppress("CyclomaticComplexMethod", "ComplexCondition")
    private fun presentationOrderContent(order: ObjectNode): ObjectNode {
        val content = dispatchMapper.createObjectNode()
        if (date != PRESENTATION_DATE) return content
        val name = normalizedText(order["name"])
        val address = normalizedText(order["address"])
        val key = if (name.isNotEmpty() && address.isNotEmpty()) "$name\u0000$address" else order["id"]?.asString().orEmpty()
        val hash = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        val request = PRESENTATION_REQUESTS[
            (hash.take(PRESENTATION_HASH_SELECTOR_LENGTH).toLong(16) % PRESENTATION_REQUESTS.size).toInt()
        ]
        if (!order.has("customerRequests") || order["customerRequests"].isNull) {
            content.set("customerRequests", dispatchMapper.createObjectNode().apply {
                put("source", "presentation")
                putArray("items").addObject().apply {
                    put("id", "request_${hash.take(PRESENTATION_REQUEST_ID_LENGTH)}")
                    put("kind", request[0]); put("label", request[1]); put("required", true)
                }
            })
        }
        val missingTip = !order.has("tip") || order["tip"].isNull
        val missingRequests = !order.has("customerRequests") || order["customerRequests"].isNull
        if (missingTip && missingRequests) {
            content.set("tip", dispatchMapper.createObjectNode().apply {
                put("body", request[2]); put("author", "배송 안내"); putNull("updatedAt"); put("source", "presentation")
            })
        }
        if (!order.has("transportConditions") || order["transportConditions"].isNull) {
            content.putArray("transportConditions").add("보냉 운송").add("포장 상태 확인")
            content.put("transportConditionSource", "presentation")
        }
        if (!content.isEmpty) content.set("presentationContent", dispatchMapper.createObjectNode().apply {
            put("date", date)
            set("fields", stringArray(content.properties().map { it.key }.toList()))
        })
        return content
    }

    private fun initialVehicleState(vehicle: ObjectNode): ObjectNode {
        val coordinates = vehicle.at("/location/coordinates") as ArrayNode
        return dispatchMapper.createObjectNode().apply {
            put("phase", "idle")
            put("scenarioPreset", "received")
            putNull("scenarioStopId")
            set("truck", dispatchMapper.createObjectNode().apply {
                setCopy("lat", coordinates[1]); setCopy("lng", coordinates[0])
                putNull("fromId"); putNull("toId"); putNull("atStopId")
                put("dwelling", false); put("dwellRemaining", 0); put("locationSource", "demo")
            })
        }
    }

    private fun customerStatus(status: String, stage: String?): ObjectNode {
        val (key, label) = when (stage) {
            "picking" -> "picking" to "피킹 중"
            "ready" -> "staged" to "출고 준비"
            "arrived" -> "arrived" to "배송지 도착"
            else -> when (status) {
                "done" -> "delivered" to "배송 완료"
                "current" -> "shipping" to "배송 중"
                "skipped" -> "held" to "배송 보류"
                else -> "paid" to "결제 완료"
            }
        }
        return dispatchMapper.createObjectNode().put("key", key).put("label", label)
    }

    private fun publicNotice(notice: ObjectNode): ObjectNode = copyObject(notice).apply { remove("_template") }

    private fun referencesOrder(record: ObjectNode, id: String): Boolean =
        record["stopId"]?.asString() == id || record["orderIds"]?.any { it.asString() == id } == true

    private fun requireVehicle(id: String?): String = id?.takeIf(vehicles::containsKey) ?: invalid("차량을 확인해 주세요.")

    private fun requireStop(id: String?): ObjectNode = id?.let(orders::get) ?: invalid("배송지를 확인해 주세요.")

    private fun scenarioNotice(order: ObjectNode, scenario: String): Pair<String, String> {
        val name = order["name"].asString()
        return when (scenario) {
            "received" -> "주문 접수 완료" to "$name 주문 접수가 확인되었습니다."
            "picking" -> "상품 준비 중" to "$name 주문 상품을 준비하고 있습니다."
            "ready" -> "출고 준비 완료" to "$name 주문의 출고 준비가 완료되었습니다."
            "shipping" -> "배송 출발" to "$name 배송이 출발했습니다."
            "arrived" -> "배송지 도착" to "$name 배송이 도착했습니다."
            else -> "배송 완료" to "$name 배송이 완료되었습니다."
        }
    }

    private fun destinationKey(order: ObjectNode): String {
        val name = normalizedText(order["name"])
        val address = normalizedText(order["address"])
        val values = if (name.isNotEmpty() && address.isNotEmpty()) listOf(name, address) else listOf("order", normalizedText(order["id"]))
        return dispatchMapper.writeValueAsString(stringArray(values))
    }

    companion object {
        private val STATUSES = setOf("pending", "current", "done", "skipped")
        private val PROTECTED_STATUSES = setOf("current", "done")
        private val PHASES = setOf("idle", "preparing", "delivering", "done")
        private val SCENARIOS = setOf("received", "picking", "ready", "shipping", "arrived", "completed")
        private val CUSTOMER_STAGES = setOf("picking", "ready", "shipping", "arrived", "completed")
        private val PHYSICAL_ACTIONS = SCENARIOS + setOf("toggle_skip", "delivery_tip")
        private val SCENARIO_LABELS = mapOf(
            "received" to "주문 접수", "picking" to "피킹 시작", "ready" to "출고 준비",
            "shipping" to "배송 출발", "arrived" to "배송지 도착", "completed" to "배송 완료",
        )
        private val ORDER_CHANGE_KEYS = setOf("vehicleId", "status", "customerStage", "tip", "arrivedAt", "completedAt")
        private val EVENT_BASE_KEYS = setOf("id", "ts", "vehicleId", "action", "type", "orderIds", "stopId", "message", "time")
        private const val TARGET_ROUTE_STOPS = 35
        private const val ROUTE_STOP_WEIGHT = 2.0
        private const val TARGET_ROUTE_BOXES = 70.0
        private const val PRESENTATION_HASH_SELECTOR_LENGTH = 8
        private const val PRESENTATION_REQUEST_ID_LENGTH = 12
        private const val PRESENTATION_DATE = "2026-09-16"
        private val PRESENTATION_REQUESTS = listOf(
            listOf("refrigerator", "매장 냉장고 안에 보관", "냉장고 보관 위치를 확인한 뒤 넣고 문이 닫혔는지 확인해 주세요."),
            listOf("doorstep", "문 앞에 두기", "출입문을 막지 않는 위치에 놓고 포장 상태를 확인해 주세요."),
            listOf("indoor", "매장 실내에 보관", "매장 안의 지정된 보관 위치에 놓아 주세요."),
            listOf("handoff", "직접 전달", "수령인에게 물량을 확인한 뒤 직접 전달해 주세요."),
        )
    }
}

private fun validDate(value: String): Boolean = value.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) &&
    runCatching { LocalDate.parse(value, DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)) }.isSuccess

private fun clockText(timestamp: Long): String =
    Instant.ofEpochMilli(timestamp)
        .atOffset(ZoneOffset.ofHours(SEOUL_UTC_OFFSET_HOURS))
        .format(DateTimeFormatter.ofPattern("HH:mm"))

private fun normalizedText(node: JsonNode?): String =
    Normalizer.normalize(node?.takeIf(JsonNode::isString)?.asString().orEmpty(), Normalizer.Form.NFC).trim()

private fun readableName(node: JsonNode?): Boolean {
    val value = node?.takeIf(JsonNode::isString)?.asString()?.trim().orEmpty()
    return value.length >= MIN_READABLE_NAME_LENGTH &&
        !Regex("^\\s*(?:\\d+층|\\d+호|지하\\s*\\d*층|문\\s*앞|실내|냉장고)\\s*$").matches(value)
}

private fun hasCoordinates(order: ObjectNode): Boolean =
    order["coordinates"] is ArrayNode && order["coordinates"].size() == 2 && order["coordinates"].all { it.finiteNumber() }

private fun JsonNode?.finiteNumber(): Boolean = this?.isNumber == true && this.doubleValue().isFinite()
private fun JsonNode?.finiteDouble(): Double? = if (finiteNumber()) this!!.doubleValue() else null
private fun JsonNode?.exactLong(): Long? {
    if (!finiteNumber()) return null
    return runCatching { this!!.decimalValue().stripTrailingZeros().longValueExact() }.getOrNull()
}
private fun JsonNode?.exactInt(): Int? = exactLong()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

private fun nullish(primary: JsonNode?, fallback: JsonNode?): JsonNode? =
    primary?.takeUnless(JsonNode::isNull) ?: fallback?.takeUnless(JsonNode::isNull)

private fun JsonNode?.stringValuesOrNull(): List<String>? =
    (this as? ArrayNode)?.takeIf { array -> array.all(JsonNode::isString) }?.toList()?.map(JsonNode::asString)

private fun ObjectNode.string(name: String): String? = get(name)?.takeIf(JsonNode::isString)?.asString()

private fun ObjectNode.stringArray(name: String): List<String> = get(name).stringValuesOrNull()
    ?: invalid("요청 내용을 확인해 주세요.")

private fun ObjectNode.putNullable(name: String, value: String?) {
    if (value == null) putNull(name) else put(name, value)
}

private fun ObjectNode.putTimeOrNull(name: String, value: JsonNode?) {
    if (value.finiteNumber()) put(name, clockText(value!!.longValue())) else putNull(name)
}

private fun ObjectNode.putJsNumber(name: String, value: Double) {
    if (value.isFinite() && value % 1.0 == 0.0 && value in Long.MIN_VALUE.toDouble()..Long.MAX_VALUE.toDouble()) put(name, value.toLong())
    else put(name, value)
}

private fun array(nodes: Iterable<JsonNode>): ArrayNode = dispatchMapper.createArrayNode().apply { nodes.forEach { add(it) } }

private fun stringArray(values: Iterable<String>): ArrayNode = dispatchMapper.createArrayNode().apply { values.forEach { add(it) } }

private fun invalid(message: String): Nothing =
    throw DispatchException(BAD_REQUEST_STATUS, "INVALID_OPERATION", message)

private fun conflict(message: String): Nothing =
    throw DispatchException(CONFLICT_STATUS, "OPERATION_REVISION_CONFLICT", message)
