// Schema-2 checkpoints are an exact compatibility boundary with the existing Node writer.
// Keep wire-level numeric constants and JSON assembly together until cross-engine parity is retired.
@file:Suppress(
    "MagicNumber",
    "MaxLineLength",
    "TooManyFunctions",
)

package com.evnsolution.meatbox.dispatch

import tools.jackson.databind.JsonNode
import tools.jackson.databind.node.ArrayNode
import tools.jackson.databind.node.ObjectNode
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.text.Normalizer
import kotlin.math.abs

@Suppress("LargeClass", "TooManyFunctions")
class DispatchPlan(
    day: ObjectNode,
    private val sourceId: String,
    private val clock: () -> Long,
    checkpoint: ObjectNode? = null,
) {
    private val sourceDay = copyObject(day)
    private val date: String
    private val checkpointOperatingDate: String
    private val vehicles: List<ObjectNode>
    private val vehicleById: Map<String, ObjectNode>
    private val orders: List<ObjectNode>
    private val orderById: Map<String, ObjectNode>
    private val units: LinkedHashMap<String, UnitData>
    private val orderUnit: Map<String, String>
    private var phase = "unplanned"
    private var mutableRevision = 0L
    private var draftVersion = 0L
    private var confirmedVersion = 0L
    private var candidateIds = emptyList<String>()
    private var draftAssignments: LinkedHashMap<String, String>? = null
    private var engine: OperationalState? = null
    private var legacyPublished = false
    private var stateTimestamp: Long

    val revision: Long get() = mutableRevision
    val today: String get() = seoulDate(clock())

    init {
        validateDay(sourceDay)
        date = sourceDay["date"]?.takeIf(JsonNode::isString)?.asString()
            ?.takeIf(::validDate) ?: fail(400, "INVALID_DATE", "배차 날짜와 운영 기준일을 확인해 주세요.")
        vehicles = createDispatchFleet(sourceDay).map { copyObject(it).apply {
            put("live", true)
            put("operationsSource", "local")
        } }
        vehicleById = vehicles.associateBy { it["id"].asString() }
        orders = (sourceDay["orders"] as ArrayNode).toList().map { it as ObjectNode }
        if (orders.any { it["name"]?.isString != true || it["address"]?.isString != true }) {
            fail(400, "INVALID_DAY", "배송지 이름과 주소를 확인해 주세요.")
        }
        orderById = orders.associateBy { it["id"].asString() }
        units = linkedMapOf()
        val unitByOrder = linkedMapOf<String, String>()
        orders.forEach { order ->
            val id = destinationId(order)
            unitByOrder[order["id"].asString()] = id
            val unit = units.getOrPut(id) {
                UnitData(id, normalized(order["name"]), normalized(order["address"]), mutableListOf(), 0.0, mutableListOf())
            }
            unit.orderIds += order["id"].asString()
            unit.boxes += order["boxes"].doubleValue()
            order["groupId"].asString().let { if (it !in unit.candidateVehicleIds) unit.candidateVehicleIds += it }
        }
        orderUnit = unitByOrder
        stateTimestamp = clock()
        checkpointOperatingDate = checkpoint?.takeIf { it["schemaVersion"].exactLong() == 2L }
            ?.get("operatingDate")?.takeIf(JsonNode::isString)?.asString() ?: today
        checkpoint?.let(::restore)
    }

    @Suppress("CyclomaticComplexMethod")
    fun snapshot(): ObjectNode {
        val currentToday = today
        val published = engine?.snapshot()
        val fleetDeliveries = published?.get("fleetDeliveries")?.asObjects().orEmpty().map { delivery ->
            copyObject(delivery).apply { put("assignmentUnitId", orderUnit[delivery["id"].asString()]) }
        }
        val confirmed = fleetDeliveries.associate { it["id"].asString() to it["vehicleId"].asString() }
        val assignments = when (phase) {
            "draft", "amending" -> draftAssignments
            else -> confirmed.takeIf { published != null }?.let(::LinkedHashMap)
        }
        val protectedUnits = fleetDeliveries.filter { it["status"].asString() in PROTECTED_STATUSES }
            .mapNotNull { orderUnit[it["id"].asString()] }.toSet()
        val defaults = publishedDefaults(fleetDeliveries)
        val base = published?.let(::copyObject) ?: emptyOperationalSnapshot()
        if (published != null) {
            val selectedState = (published["vehicleStates"] as? ObjectNode)?.get(defaults.first) as? ObjectNode
            val selectedVehicle = published["fleetVehicles"].asObjects().firstOrNull { it["id"].asString() == defaults.first }
                ?: vehicleById[defaults.first]
            val selectedDeliveries = fleetDeliveries.filter { it["vehicleId"].asString() == defaults.first }
            base.setCopy("vehicle", selectedVehicle)
            base.set("deliveries", jsonArray(selectedDeliveries))
            base.setCopy("truck", selectedState?.get("truck"))
            base.put("phase", selectedState?.get("phase")?.asString() ?: "idle")
            base.setCopy("kpi", selectedState?.get("kpi") ?: dispatchMapper.createObjectNode())
            base.putNullable("customerStopId", defaults.second)
            base.setCopy("scenarioPreset", selectedState?.get("scenarioPreset"))
            base.setCopy("scenarioStopId", selectedState?.get("scenarioStopId"))
        }
        base.set("fleetDeliveries", jsonArray(fleetDeliveries))
        base.set("sourceData", dispatchMapper.createObjectNode().apply {
            (published?.get("sourceData") as? ObjectNode)?.properties()?.forEach { (key, value) -> setCopy(key, value) }
            put("date", date)
            put("sourceId", sourceId)
            setCopy("summary", sourceDay["summary"])
            put("operatingDate", currentToday)
            putNullable("defaultVehicleId", defaults.first)
            putNullable("defaultStopId", defaults.second)
        })
        base.put("revision", mutableRevision)
        base.set("dispatch", dispatchState(assignments, confirmed, currentToday))
        val locked = date < currentToday || phase in setOf("published", "amending")
        base.set("dispatchCandidates", jsonArray(vehicles.map { dispatchCandidate(it, locked) }))
        base.set("dispatchPreview", jsonArray(if (phase == "unplanned") emptyList() else candidateIds.map { summaryFor(assignments, it) }))
        base.set("dispatchOrders", jsonArray(orders.map { order -> copyObject(order).apply {
            val id = order["id"].asString()
            val vehicleId = assignments?.get(id)
            setCopy("originalGroupId", order["groupId"])
            setCopy("candidateGroupId", order["groupId"])
            put("assignmentUnitId", orderUnit.getValue(id))
            put("status", fleetDeliveries.firstOrNull { it["id"].asString() == id }?.get("status")?.asString() ?: "pending")
            put("assignmentProtected", orderUnit[id] in protectedUnits)
            putNullable("vehicleId", vehicleId)
            put("driver", vehicleId?.let(vehicleById::get)?.get("driver")?.asString().orEmpty())
        } }))
        return base
    }

    private fun dispatchCandidate(vehicle: ObjectNode, locked: Boolean): ObjectNode = dispatchMapper.createObjectNode().apply {
        for (field in listOf("id", "driver", "plate", "region")) put(field, vehicle[field].asString())
        put("locked", locked)
    }

    fun exportCheckpoint(): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("schemaVersion", 2)
        put("date", date)
        put("sourceId", sourceId)
        put("operatingDate", checkpointOperatingDate)
        put("revision", mutableRevision)
        put("phase", phase)
        put("draftVersion", draftVersion)
        put("confirmedVersion", confirmedVersion)
        put("stateTimestamp", stateTimestamp)
        put("legacyPublished", legacyPublished)
        set("candidateIds", stringArray(candidateIds))
        if (phase in setOf("draft", "amending")) {
            set("draftAssignments", dispatchMapper.createObjectNode().apply { draftAssignments.orEmpty().forEach(::put) })
        } else putNull("draftAssignments")
        engine?.let { set("confirmedEngineCheckpoint", it.exportCheckpoint()) } ?: putNull("confirmedEngineCheckpoint")
    }

    fun command(command: ObjectNode): ObjectNode {
        val expected = command["expectedRevision"].exactLong()?.takeIf { it >= 0 }
            ?: fail(400, "REVISION_REQUIRED", "현재 상태 revision이 필요합니다.")
        if (expected != mutableRevision) fail(409, "REVISION_CONFLICT", "배차 상태가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.")
        requireWritable()
        val result = when (command["type"]?.takeIf(JsonNode::isString)?.asString()) {
            "calculate_dispatch" -> calculate(command)
            "reassign" -> reassign(command)
            "publish_dispatch" -> publish(command)
            "begin_dispatch_revision" -> beginRevision(command)
            "discard_dispatch_revision" -> discardRevision(command)
            "set_route_order", "start_route", "arrive_stop", "complete_stop", "skip_stop", "set_delivery_tip" -> operational(command)
            else -> fail(400, "INVALID_COMMAND", "지원하지 않는 배차 명령입니다.")
        }
        mutableRevision += 1
        return dispatchMapper.createObjectNode().apply {
            set("state", snapshot())
            set("result", result)
        }
    }

    @Suppress("ComplexCondition")
    private fun calculate(command: ObjectNode): ObjectNode {
        if (engine != null) fail(409, "DISPATCH_ALREADY_PUBLISHED", "전송한 배차는 수정안에서 핀배차로 조정해 주세요.")
        val selected = command["vehicleIds"].strings()
        if (selected == null || selected.isEmpty() || selected.distinct().size != selected.size || selected.any { it !in vehicleById }) {
            fail(400, "INVALID_CANDIDATES", "계산할 차량을 확인해 주세요.")
        }
        val calculated = DispatchCalculator.calculate(
            orders = copyNode(sourceDay["orders"]) as ArrayNode,
            vehicles = vehicles.map(::copyObject),
            vehicleIds = selected,
            units = units.values.map(UnitData::toJson),
        )
        val assignments = assignmentsFrom(calculated)
        if (assignments.values.any { it !in selected }) fail(400, "INVALID_ASSIGNMENT", "선택한 차량에 대한 배차 결과만 사용할 수 있습니다.")
        validateUnits(assignments)
        draftAssignments = assignments
        candidateIds = selected
        phase = "draft"
        draftVersion += 1
        stateTimestamp = clock()
        return dispatchMapper.createObjectNode().apply {
            put("type", "calculate_dispatch")
            put("draftVersion", draftVersion)
            set("candidateIds", stringArray(candidateIds))
            set("summary", dispatchState(assignments)["summary"])
        }
    }

    private fun reassign(command: ObjectNode): ObjectNode {
        if (phase == "published") fail(409, "DISPATCH_ALREADY_PUBLISHED", "전송한 배차는 변경할 수 없습니다.")
        if (phase !in setOf("draft", "amending")) fail(409, "DISPATCH_DRAFT_REQUIRED", "배차 계산 후 주문을 조정해 주세요.")
        val target = command["targetVehicleId"]?.takeIf(JsonNode::isString)?.asString()
            ?: command["targetGroupId"]?.takeIf(JsonNode::isString)?.asString()
        if (target !in vehicleById) fail(400, "INVALID_VEHICLE", "배차 대상 차량을 확인해 주세요.")
        if (target !in candidateIds) fail(400, "INVALID_CANDIDATE", "선택한 후보 차량 안에서 배차해 주세요.")
        val requested = command["orderIds"].strings()
        if (requested == null || requested.isEmpty() || requested.any { it !in orderById }) fail(400, "INVALID_ORDERS", "재배정할 주문을 확인해 주세요.")
        val distinctRequested = requested.distinct()
        val affectedUnitIds = distinctRequested.map(orderUnit::getValue).distinct()
        val expandedOrderIds = affectedUnitIds.flatMap { units.getValue(it).orderIds }
        val current = draftAssignments ?: fail(409, "DISPATCH_DRAFT_REQUIRED", "배차 계산 후 주문을 조정해 주세요.")
        val changed = expandedOrderIds.filter { current[it] != target }
        if (changed.isEmpty()) fail(400, "NO_ASSIGNMENT_CHANGE", "선택한 배송지는 이미 해당 차량에 배차되어 있습니다.")
        val next = LinkedHashMap(current)
        expandedOrderIds.forEach { next[it] = target!! }
        validateUnits(next)
        validateProtectedChanges(next)
        draftAssignments = next
        draftVersion += 1
        stateTimestamp = clock()
        return dispatchMapper.createObjectNode().apply {
            put("type", "reassign")
            put("targetVehicleId", target)
            set("requestedOrderIds", stringArray(distinctRequested))
            set("expandedOrderIds", stringArray(expandedOrderIds))
            set("affectedUnitIds", stringArray(affectedUnitIds))
            put("changedCount", changed.size)
            putJsNumber("changedBoxes", changed.sumOf { orderById.getValue(it)["boxes"].doubleValue() })
            put("draftVersion", draftVersion)
            put("persisted", false)
        }
    }

    @Suppress("CyclomaticComplexMethod")
    private fun publish(command: ObjectNode): ObjectNode {
        if (phase == "published") fail(409, "DISPATCH_ALREADY_PUBLISHED", "이미 전송한 배차입니다.")
        if (phase !in setOf("draft", "amending") || command["draftVersion"].exactLong() != draftVersion) {
            fail(409, "DRAFT_CONFLICT", "배차 초안이 바뀌었습니다. 최신 초안을 확인해 주세요.")
        }
        val assignments = draftAssignments ?: fail(409, "DRAFT_CONFLICT", "배차 초안이 바뀌었습니다. 최신 초안을 확인해 주세요.")
        validateUnits(assignments)
        validateProtectedChanges(assignments)
        val amended = phase == "amending"
        val changed = if (amended) changedAssignments(assignments) else emptyList()
        if (amended && changed.isEmpty()) fail(409, "NO_ASSIGNMENT_CHANGE", "변경된 배차가 없습니다.")
        val nextEngine = OperationalState(sourceDay, sourceId, clock, if (amended) engine!!.exportCheckpoint() else baseCheckpoint(assignments))
        if (amended) {
            changed.groupBy { assignments.getValue(it["id"].asString()) }.forEach { (target, changedOrders) ->
                val ids = changedOrders.groupBy { orderUnit.getValue(it["id"].asString()) }.values.flatten().map { it["id"].asString() }
                nextEngine.command(dispatchMapper.createObjectNode().apply {
                    put("type", "reassign")
                    put("targetVehicleId", target)
                    set("orderIds", stringArray(ids))
                    put("expectedRevision", nextEngine.revision)
                })
            }
        }
        val deliveries = nextEngine.snapshot()["fleetDeliveries"].asObjects()
        if (deliveries.size != orders.size || deliveries.map { it["id"].asString() }.toSet().size != orders.size ||
            deliveries.any { assignments[it["id"].asString()] != it["vehicleId"].asString() }
        ) fail(400, "INVALID_ASSIGNMENT", "확정 배차 구성을 확인해 주세요.")
        engine = nextEngine
        phase = "published"
        confirmedVersion = draftVersion
        draftAssignments = null
        legacyPublished = false
        stateTimestamp = clock()
        return dispatchMapper.createObjectNode().apply {
            put("type", "publish_dispatch")
            put("confirmedVersion", confirmedVersion)
            put("amended", amended)
            put("changedCount", changed.size)
            put("orders", deliveries.size)
            put("destinations", units.size)
            putJsNumber("boxes", orders.sumOf { it["boxes"].doubleValue() })
            put("shared", true)
        }
    }

    private fun beginRevision(command: ObjectNode): ObjectNode {
        if (phase != "published") fail(409, "DISPATCH_NOT_PUBLISHED", "확정된 배차에서 수정안을 만들 수 있습니다.")
        val assignments = confirmedAssignments()
        validateUnits(assignments)
        draftAssignments = assignments
        phase = "amending"
        draftVersion += 1
        stateTimestamp = clock()
        return dispatchMapper.createObjectNode().apply { put("type", command["type"].asString()); put("draftVersion", draftVersion) }
    }

    private fun discardRevision(command: ObjectNode): ObjectNode {
        if (phase != "amending") fail(409, "DISPATCH_DRAFT_REQUIRED", "취소할 수정안이 없습니다.")
        draftAssignments = null
        phase = "published"
        draftVersion = confirmedVersion
        stateTimestamp = clock()
        return dispatchMapper.createObjectNode().apply { put("type", command["type"].asString()); put("confirmedVersion", confirmedVersion) }
    }

    private fun operational(command: ObjectNode): ObjectNode {
        val currentEngine = engine ?: fail(409, "DISPATCH_NOT_PUBLISHED", "배차 전송 후 운행 상태를 변경할 수 있습니다.")
        validateRouteOrder(command, currentEngine.snapshot())
        val delegated = copyObject(command).apply { put("expectedRevision", currentEngine.revision) }
        return currentEngine.command(delegated)["result"] as ObjectNode
    }

    private fun validateRouteOrder(command: ObjectNode, operational: ObjectNode) {
        val requested = command["order"].strings() ?: return
        val vehicleId = command["vehicleId"]?.takeIf(JsonNode::isString)?.asString() ?: return
        val current = operational["fleetDeliveries"].asObjects().filter { it["vehicleId"].asString() == vehicleId }
        val positions = requested.withIndex().associate { (index, id) -> id to index }
        current.groupBy { orderUnit[it["id"].asString()] }.values.forEach { grouped ->
            val ids = grouped.map { it["id"].asString() }
            if (ids.size > 1 && ids.all(positions::containsKey)) {
                val indexes = ids.map(positions::getValue).sorted()
                if (indexes.withIndex().any { (place, index) -> place > 0 && index != indexes[place - 1] + 1 }) {
                    fail(400, "DESTINATION_SPLIT", "같은 배송지의 주문 순서는 서로 붙어 있어야 합니다.")
                }
            }
        }
    }

    @Suppress("ComplexCondition", "CyclomaticComplexMethod", "LongMethod")
    private fun restore(saved: ObjectNode) {
        if (saved["schemaVersion"].exactLong() == 1L) {
            val savedRevision = saved["revision"].exactLong()?.takeIf { it > 0 }
                ?: fail(400, "INVALID_CHECKPOINT", "저장된 배차 상태를 확인해 주세요.")
            engine = runCatching { OperationalState(sourceDay, sourceId, clock, saved) }
                .getOrElse { fail(400, "INVALID_CHECKPOINT", "저장된 배차 상태를 확인해 주세요.") }
            val deliveries = engine!!.snapshot()["fleetDeliveries"].asObjects()
            phase = "published"
            mutableRevision = savedRevision
            draftVersion = 1
            confirmedVersion = 1
            candidateIds = deliveries.map { it["vehicleId"].asString() }.distinct()
            legacyPublished = true
            stateTimestamp = saved["stateTimestamp"].doubleValue().toLong()
            return
        }
        val valid = saved["schemaVersion"].exactLong() == 2L && saved.text("date") == date && saved.text("sourceId") == sourceId &&
            validDate(saved.text("operatingDate")) && saved.text("phase") in PHASES && saved["revision"].exactLong()?.let { it >= 0 } == true &&
            saved["draftVersion"].exactLong()?.let { it >= 0 } == true && saved["confirmedVersion"].exactLong()?.let { it >= 0 } == true &&
            saved["stateTimestamp"].finite() && saved["candidateIds"].strings()?.let { it.distinct().size == it.size && it.all(vehicleById::containsKey) } == true &&
            saved["legacyPublished"]?.isBoolean == true && saved.has("draftAssignments") && saved.has("confirmedEngineCheckpoint")
        if (!valid) invalidCheckpoint()
        val savedPhase = saved.text("phase")!!
        val savedRevision = saved["revision"].exactLong()!!
        val savedDraftVersion = saved["draftVersion"].exactLong()!!
        val savedConfirmedVersion = saved["confirmedVersion"].exactLong()!!
        val savedCandidates = saved["candidateIds"].strings()!!
        val savedLegacy = saved["legacyPublished"].booleanValue()
        val savedDraft = saved["draftAssignments"]
        val savedConfirmed = saved["confirmedEngineCheckpoint"] as? ObjectNode
        when (savedPhase) {
            "unplanned" -> if (!savedDraft.isNullish() || savedConfirmed != null || savedLegacy || savedRevision != 0L || savedDraftVersion != 0L || savedConfirmedVersion != 0L || savedCandidates.isNotEmpty()) invalidCheckpoint()
            "draft" -> {
                val assignments = assignmentsFrom(savedDraft as? ObjectNode ?: invalidCheckpoint())
                validateUnits(assignments)
                if (savedConfirmed != null || savedLegacy || savedDraftVersion < 1 || savedConfirmedVersion != 0L || savedRevision != savedDraftVersion || savedCandidates.isEmpty() || assignments.values.any { it !in savedCandidates }) invalidCheckpoint()
                draftAssignments = assignments
            }
            "published" -> {
                if (savedConfirmed == null || !savedDraft.isNullish() || savedDraftVersion < 1 || savedConfirmedVersion != savedDraftVersion || savedCandidates.isEmpty()) invalidCheckpoint()
                engine = restoreEngine(savedConfirmed)
                val assignments = confirmedAssignments()
                if (assignments.size != orders.size || assignments.values.any { it !in savedCandidates }) invalidCheckpoint()
                if (!savedLegacy) validateUnits(assignments)
                if (savedRevision < engine!!.revision) invalidCheckpoint()
            }
            "amending" -> {
                if (savedConfirmed == null || savedConfirmedVersion < 1 || savedDraftVersion <= savedConfirmedVersion || savedCandidates.isEmpty()) invalidCheckpoint()
                engine = restoreEngine(savedConfirmed)
                if (savedRevision < engine!!.revision) invalidCheckpoint()
                val assignments = assignmentsFrom(savedDraft as? ObjectNode ?: invalidCheckpoint())
                validateUnits(assignments)
                val confirmed = confirmedAssignments()
                validateUnits(confirmed)
                if ((assignments.values + confirmed.values).any { it !in savedCandidates }) invalidCheckpoint()
                draftAssignments = assignments
            }
        }
        phase = savedPhase
        mutableRevision = savedRevision
        draftVersion = savedDraftVersion
        confirmedVersion = savedConfirmedVersion
        candidateIds = savedCandidates
        legacyPublished = savedLegacy
        stateTimestamp = saved["stateTimestamp"].doubleValue().toLong()
    }

    private fun restoreEngine(saved: ObjectNode): OperationalState =
        runCatching { OperationalState(sourceDay, sourceId, clock, saved) }.getOrElse { invalidCheckpoint() }

    private fun baseCheckpoint(assignments: Map<String, String>): ObjectNode {
        val vehicleIds = (sourceDay["groups"] as ArrayNode).toList().map { it["id"].asString() }
        val initial = vehicleIds.associateWith { mutableListOf<String>() }
        val assigned = vehicleIds.associateWith { mutableListOf<String>() }
        val positions = orders.mapIndexed { index, order -> order["id"].asString() to index }.toMap()
        orders.forEach { order ->
            val id = order["id"].asString()
            initial.getValue(order["groupId"].asString()) += id
            assigned.getValue(assignments.getValue(id)) += id
        }
        fun sorted(route: List<String>) = route.sortedWith(compareBy<String>({ orderById.getValue(it)["sequence"]?.doubleValue() ?: 0.0 }, { positions.getValue(it) }))
        val routes = dispatchMapper.createObjectNode()
        vehicleIds.forEach { vehicleId ->
            val before = sorted(initial.getValue(vehicleId))
            val grouped = sorted(assigned.getValue(vehicleId)).groupBy { orderUnit.getValue(it) }.values.flatten()
            if (before != grouped) routes.set(vehicleId, stringArray(grouped))
        }
        val changedOrders = dispatchMapper.createObjectNode()
        orders.forEach { order ->
            val id = order["id"].asString()
            if (assignments[id] != order["groupId"].asString()) changedOrders.set(id, dispatchMapper.createObjectNode().apply { put("vehicleId", assignments[id]) })
        }
        return dispatchMapper.createObjectNode().apply {
            put("schemaVersion", 1)
            put("presentationContentVersion", 0)
            put("date", date)
            put("sourceId", sourceId)
            put("revision", 0)
            put("stateTimestamp", clock())
            put("nextEventId", 1)
            put("nextNoticeId", 1)
            set("routes", routes)
            set("orders", changedOrders)
            set("states", dispatchMapper.createObjectNode())
            putArray("events")
            putArray("notices")
        }
    }

    private fun emptyOperationalSnapshot(): ObjectNode = dispatchMapper.createObjectNode().apply {
        put("simTime", stateTimestamp)
        put("simClock", Instant.ofEpochMilli(stateTimestamp).atZone(SEOUL).format(DateTimeFormatter.ofPattern("HH:mm")))
        set("fleetVehicles", jsonArray(vehicles.map(::copyObject)))
        putArray("fleetDeliveries")
        set("vehicleStates", dispatchMapper.createObjectNode())
        setCopy("vehicle", candidateIds.firstOrNull()?.let(vehicleById::get) ?: vehicles.firstOrNull())
        putArray("deliveries")
        putNull("truck")
        put("phase", "idle")
        set("kpi", dispatchMapper.createObjectNode())
        putNull("customerStopId")
        putNull("scenarioPreset")
        putNull("scenarioStopId")
        put("speed", 0)
        putNull("device")
        putArray("incidents")
        putNull("nextStep")
        putArray("events")
        putArray("notifications")
    }

    private fun dispatchState(assignments: Map<String, String>?, confirmed: Map<String, String> = confirmedAssignments(), currentToday: String = today): ObjectNode {
        val readOnly = date < currentToday
        val splitLegacy = legacyPublished && units.values.any { unit -> unit.orderIds.mapNotNull(confirmed::get).toSet().size > 1 }
        val hasChanges = phase == "amending" && changedAssignments(assignments.orEmpty(), confirmed).isNotEmpty()
        return dispatchMapper.createObjectNode().apply {
            put("phase", phase)
            put("today", currentToday)
            put("readOnly", readOnly)
            set("candidateIds", stringArray(candidateIds))
            put("draftVersion", draftVersion)
            put("confirmedVersion", confirmedVersion)
            set("summary", dispatchMapper.createObjectNode().apply {
                put("orders", orders.size)
                put("destinations", units.size)
                putJsNumber("boxes", orders.sumOf { it["boxes"].doubleValue() })
            })
            put("canCalculate", !readOnly && phase in setOf("unplanned", "draft"))
            put("canAmend", !readOnly && phase == "published" && !splitLegacy)
            put("amendmentBlockedReason", if (splitLegacy) "동일 배송지가 여러 차량에 나뉜 기존 기록입니다. 배정 충돌을 확인해야 수정할 수 있습니다." else "")
            put("hasChanges", hasChanges)
            put("canPublish", !readOnly && (phase == "draft" || hasChanges))
        }
    }

    private fun publishedDefaults(deliveries: List<ObjectNode>): Pair<String?, String?> {
        val routes = candidateIds.associateWith { id -> deliveries.filter { it["vehicleId"].asString() == id } }
        val available = candidateIds.filter { routes[it].orEmpty().isNotEmpty() }
        val readable = available.filter { id ->
            val route = routes.getValue(id)
            route.all(::hasCoordinates) && route.count { readableName(it["name"]) } >= (route.size + 1) / 2
        }
        val defaultVehicle = (readable.ifEmpty { available }).minWithOrNull(compareBy<String>({ id ->
            val route = routes.getValue(id)
            abs(route.size - 35) * 2.0 + abs(route.sumOf { it["boxes"].doubleValue() } - 70.0)
        }, { it })) ?: candidateIds.firstOrNull() ?: vehicles.firstOrNull()?.get("id")?.asString()
        val route = defaultVehicle?.let(routes::get).orEmpty()
        val defaultStop = route.firstOrNull { it["status"].asString() == "current" }?.get("id")?.asString()
            ?: route.firstOrNull { hasCoordinates(it) && readableName(it["name"]) }?.get("id")?.asString()
            ?: route.firstOrNull()?.get("id")?.asString()
        return defaultVehicle to defaultStop
    }

    private fun summaryFor(assignments: Map<String, String>?, vehicleId: String): ObjectNode {
        val selected = orders.filter { assignments?.get(it["id"].asString()) == vehicleId }
        return dispatchMapper.createObjectNode().apply {
            put("vehicleId", vehicleId)
            put("orders", selected.size)
            put("destinations", selected.map { orderUnit.getValue(it["id"].asString()) }.toSet().size)
            putJsNumber("boxes", selected.sumOf { it["boxes"].doubleValue() })
        }
    }

    private fun assignmentsFrom(node: ObjectNode): LinkedHashMap<String, String> {
        if (node.size() != orderById.size) fail(400, "INVALID_ASSIGNMENT", "모든 주문의 배차 결과가 필요합니다.")
        val result = linkedMapOf<String, String>()
        node.properties().forEach { (orderId, value) ->
            val vehicleId = value.takeIf(JsonNode::isString)?.asString()
            if (orderId !in orderById || orderId in result || vehicleId !in vehicleById) fail(400, "INVALID_ASSIGNMENT", "배차 결과의 주문과 차량을 확인해 주세요.")
            result[orderId] = vehicleId!!
        }
        if (result.size != orderById.size) fail(400, "INVALID_ASSIGNMENT", "모든 주문의 배차 결과가 필요합니다.")
        return result
    }

    private fun confirmedAssignments(): LinkedHashMap<String, String> = linkedMapOf<String, String>().apply {
        engine?.snapshot()?.get("fleetDeliveries").asObjects().forEach { put(it["id"].asString(), it["vehicleId"].asString()) }
    }

    private fun changedAssignments(assignments: Map<String, String>, confirmed: Map<String, String> = confirmedAssignments()): List<ObjectNode> =
        orders.filter { assignments[it["id"].asString()] != confirmed[it["id"].asString()] }

    private fun validateUnits(assignments: Map<String, String>) {
        if (units.values.any { unit -> unit.orderIds.mapNotNull(assignments::get).toSet().size != 1 || unit.orderIds.any { it !in assignments } }) {
            fail(400, "DESTINATION_SPLIT", "같은 배송지의 주문은 한 차량에 함께 배차해야 합니다.")
        }
    }

    private fun validateProtectedChanges(assignments: Map<String, String>) {
        val confirmed = engine?.snapshot()?.get("fleetDeliveries").asObjects()
        val protectedUnits = confirmed.orEmpty().filter { it["status"].asString() in PROTECTED_STATUSES }
            .mapNotNull { orderUnit[it["id"].asString()] }.toSet()
        if (confirmed.orEmpty().any { order -> orderUnit[order["id"].asString()] in protectedUnits && assignments[order["id"].asString()] != order["vehicleId"].asString() }) {
            fail(409, "PROTECTED_DESTINATION", "진행 중이거나 완료된 배송지의 주문 묶음은 재배정할 수 없습니다. 수정안을 확인해 주세요.")
        }
    }

    private fun requireWritable() {
        if (date < today) fail(409, "DATE_READ_ONLY", "과거 배차일은 조회만 할 수 있습니다.")
    }

    private data class UnitData(
        val id: String,
        val name: String,
        val address: String,
        val orderIds: MutableList<String>,
        var boxes: Double,
        val candidateVehicleIds: MutableList<String>,
    ) {
        fun toJson(): ObjectNode = dispatchMapper.createObjectNode().apply {
            put("id", id)
            put("name", name)
            put("address", address)
            set("orderIds", stringArray(orderIds))
            putJsNumber("boxes", boxes)
            set("candidateVehicleIds", stringArray(candidateVehicleIds))
        }
    }

    private companion object {
        val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
        val PHASES = setOf("unplanned", "draft", "published", "amending")
        val PROTECTED_STATUSES = setOf("current", "done")
    }
}

private fun destinationId(order: ObjectNode): String {
    val content = "${normalized(order["name"])}\u0000${normalized(order["address"])}"
    return "destination-" + MessageDigest.getInstance("SHA-256").digest(content.toByteArray()).joinToString("") { "%02x".format(it) }
}

private fun normalized(value: JsonNode?): String =
    Normalizer.normalize(value?.takeIf(JsonNode::isString)?.asString().orEmpty(), Normalizer.Form.NFC).trim()

private fun validDate(value: String?): Boolean = value != null && runCatching {
    LocalDate.parse(value, DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)).toString() == value
}.getOrDefault(false)

private fun seoulDate(timestamp: Long): String = Instant.ofEpochMilli(timestamp).atZone(ZoneId.of("Asia/Seoul")).toLocalDate().toString()
private fun JsonNode?.exactLong(): Long? = if (this?.isNumber == true && doubleValue().isFinite()) runCatching { decimalValue().stripTrailingZeros().longValueExact() }.getOrNull() else null
private fun JsonNode?.finite(): Boolean = this?.isNumber == true && doubleValue().isFinite()
private fun JsonNode?.strings(): List<String>? = (this as? ArrayNode)?.takeIf { it.all(JsonNode::isString) }?.toList()?.map { it.asString() }
private fun JsonNode?.asObjects(): List<ObjectNode> = (this as? ArrayNode)?.mapNotNull { it as? ObjectNode }.orEmpty()
private fun JsonNode?.isNullish(): Boolean = this == null || isNull
private fun ObjectNode.text(name: String): String? = get(name)?.takeIf(JsonNode::isString)?.asString()
private fun ObjectNode.putNullable(name: String, value: String?) { if (value == null) putNull(name) else put(name, value) }
private fun ObjectNode.putJsNumber(name: String, value: Double) {
    if (value.isFinite() && value % 1.0 == 0.0 && value in Long.MIN_VALUE.toDouble()..Long.MAX_VALUE.toDouble()) put(name, value.toLong()) else put(name, value)
}
private fun jsonArray(nodes: Iterable<JsonNode>): ArrayNode = dispatchMapper.createArrayNode().apply { nodes.forEach(::add) }
private fun stringArray(values: Iterable<String>): ArrayNode = dispatchMapper.createArrayNode().apply { values.forEach(::add) }
private fun hasCoordinates(order: ObjectNode): Boolean = (order["coordinates"] as? ArrayNode)?.let { it.size() == 2 && it.all { value -> value.isNumber && value.doubleValue().isFinite() } } == true
private fun readableName(node: JsonNode?): Boolean {
    val value = node?.takeIf(JsonNode::isString)?.asString()?.trim().orEmpty()
    return value.length >= 4 && !Regex("^\\s*(?:\\d+층|\\d+호|지하\\s*\\d*층|문\\s*앞|실내|냉장고)\\s*$").matches(value)
}
private fun fail(status: Int, code: String, message: String): Nothing = throw DispatchException(status, code, message)
private fun invalidCheckpoint(): Nothing = fail(400, "INVALID_CHECKPOINT", "저장된 배차 상태를 확인해 주세요.")
