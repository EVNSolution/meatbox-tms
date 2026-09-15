import { createHash } from 'node:crypto';
import { createDispatchFleet } from '../apps/combined/dispatch-assignment.mjs';
import { createSourceOperations } from './source-operations.mjs';

const operationalCommands = new Set(['set_scenario', 'arrive_stop', 'complete_stop', 'set_route_order', 'toggle_skip', 'set_delivery_tip', 'send_customer_notice']);

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const clone = value => value == null ? value : structuredClone(value);
const normalize = value => String(value ?? '').trim().normalize('NFC');
const unitId = order => `destination-${createHash('sha256').update(`${normalize(order.name)}\0${normalize(order.address)}`).digest('hex')}`;

function assignmentsFrom(value, orderById, vehicleById) {
  const entries = value instanceof Map ? [...value] : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
  if (!entries || entries.length !== orderById.size) fail(400, 'INVALID_ASSIGNMENT', '모든 주문의 배차 결과가 필요합니다.');
  const assignments = new Map();
  for (const [orderId, vehicleId] of entries) {
    if (!orderById.has(orderId) || assignments.has(orderId) || !vehicleById.has(vehicleId)) fail(400, 'INVALID_ASSIGNMENT', '배차 결과의 주문과 차량을 확인해 주세요.');
    assignments.set(orderId, vehicleId);
  }
  if (assignments.size !== orderById.size) fail(400, 'INVALID_ASSIGNMENT', '모든 주문의 배차 결과가 필요합니다.');
  return assignments;
}

function validateUnits(assignments, units) {
  for (const unit of units.values()) {
    const assigned = new Set(unit.orderIds.map(id => assignments.get(id)));
    if (assigned.size !== 1 || assigned.has(undefined)) fail(400, 'DESTINATION_SPLIT', '같은 배송지의 주문은 한 차량에 함께 배차해야 합니다.');
  }
}

function baseCheckpoint(day, sourceId, assignments, timestamp) {
  const vehicleIds = day.groups.map(group => group.id);
  const initial = new Map(vehicleIds.map(id => [id, []]));
  const assigned = new Map(vehicleIds.map(id => [id, []]));
  const position = new Map(day.orders.map((order, index) => [order.id, index]));
  for (const order of day.orders) {
    initial.get(order.groupId).push(order.id);
    assigned.get(assignments.get(order.id)).push(order.id);
  }
  const sortOrders = route => route.sort((left, right) => {
    const leftOrder = day.orders[position.get(left)];
    const rightOrder = day.orders[position.get(right)];
    return (leftOrder.sequence ?? 0) - (rightOrder.sequence ?? 0) || position.get(left) - position.get(right);
  });
  for (const route of initial.values()) sortOrders(route);
  for (const [vehicleId, route] of assigned) {
    const grouped = new Map();
    for (const orderId of sortOrders(route)) {
      const id = unitId(day.orders[position.get(orderId)]);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(orderId);
    }
    assigned.set(vehicleId, [...grouped.values()].flat());
  }
  const routes = {};
  for (const id of vehicleIds) {
    const before = initial.get(id);
    const after = assigned.get(id);
    if (before.length !== after.length || before.some((orderId, index) => orderId !== after[index])) routes[id] = after;
  }
  const orders = {};
  for (const order of day.orders) if (assignments.get(order.id) !== order.groupId) orders[order.id] = { vehicleId: assignments.get(order.id) };
  return {
    schemaVersion: 1,
    date: day.date,
    sourceId,
    revision: 0,
    stateTimestamp: timestamp,
    nextEventId: 1,
    nextNoticeId: 1,
    routes,
    orders,
    states: {},
    events: [],
    notices: [],
  };
}

export function createDispatchOperations(day, { sourceId = '', operatingDate, now = Date.now, checkpoint = null, calculator = null } = {}) {
  if (!validDate(day?.date) || !validDate(operatingDate)) fail(400, 'INVALID_DATE', '배차 날짜와 운영 기준일을 확인해 주세요.');
  if (typeof sourceId !== 'string' || typeof now !== 'function' || (calculator !== null && typeof calculator !== 'function')) fail(400, 'INVALID_OPTIONS', '배차 실행 옵션을 확인해 주세요.');

  let fleet;
  try { fleet = createDispatchFleet(day); } catch (error) { fail(400, 'INVALID_DAY', error.message || '배차 원본 자료를 확인해 주세요.'); }
  if (day.orders.some(order => typeof order.name !== 'string' || typeof order.address !== 'string')) fail(400, 'INVALID_DAY', '배송지 이름과 주소를 확인해 주세요.');
  const vehicles = fleet.map(vehicle => ({ ...vehicle, live: true, operationsSource: 'local' }));
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const orderById = new Map(day.orders.map(order => [order.id, order]));
  const units = new Map();
  const orderUnit = new Map();
  for (const order of day.orders) {
    const id = unitId(order);
    orderUnit.set(order.id, id);
    if (!units.has(id)) units.set(id, { id, name: normalize(order.name), address: normalize(order.address), orderIds: [], boxes: 0, candidateVehicleIds: [] });
    const unit = units.get(id);
    unit.orderIds.push(order.id);
    unit.boxes += order.boxes;
    if (!unit.candidateVehicleIds.includes(order.groupId)) unit.candidateVehicleIds.push(order.groupId);
  }

  const readOnly = day.date < operatingDate;
  let phase = 'unplanned';
  let revision = 0;
  let draftVersion = 0;
  let confirmedVersion = 0;
  let candidateIds = [];
  let draftAssignments = null;
  let engine = null;
  let legacyPublished = false;
  let stateTimestamp = now();

  function summaryFor(assignments, vehicleId) {
    const orders = assignments ? day.orders.filter(order => assignments.get(order.id) === vehicleId) : [];
    return {
      vehicleId,
      orders: orders.length,
      destinations: new Set(orders.map(order => orderUnit.get(order.id))).size,
      boxes: orders.reduce((sum, order) => sum + order.boxes, 0),
    };
  }

  function dispatchState(assignments) {
    return {
      phase,
      today: operatingDate,
      readOnly,
      candidateIds: [...candidateIds],
      draftVersion,
      confirmedVersion,
      summary: {
        orders: day.orders.length,
        destinations: units.size,
        boxes: day.orders.reduce((sum, order) => sum + order.boxes, 0),
      },
      canCalculate: !readOnly && phase !== 'published' && Boolean(calculator),
    };
  }

  const readableName = value => typeof value === 'string' && value.trim().length >= 4
    && !/^\s*(?:\d+층|\d+호|지하\s*\d*층|문\s*앞|실내|냉장고)\s*$/u.test(value);

  function publishedDefaults(deliveries) {
    const routes = new Map(candidateIds.map(id => [id, deliveries.filter(order => order.vehicleId === id)]));
    const available = candidateIds.filter(id => routes.get(id)?.length);
    const readable = available.filter(id => {
      const orders = routes.get(id);
      return orders.every(order => Array.isArray(order.coordinates) && order.coordinates.length === 2 && order.coordinates.every(Number.isFinite))
        && orders.filter(order => readableName(order.name)).length >= Math.ceil(orders.length / 2);
    });
    const defaultVehicleId = (readable.length ? readable : available).sort((left, right) => {
      const score = id => Math.abs(routes.get(id).length - 35) * 2 + Math.abs(routes.get(id).reduce((sum, order) => sum + order.boxes, 0) - 70);
      return score(left) - score(right) || left.localeCompare(right);
    })[0] ?? candidateIds[0] ?? vehicles[0]?.id ?? null;
    const route = routes.get(defaultVehicleId) || [];
    const defaultStopId = route.find(order => order.status === 'current')?.id
      ?? route.find(order => Array.isArray(order.coordinates) && readableName(order.name))?.id
      ?? route[0]?.id ?? null;
    return { defaultVehicleId, defaultStopId };
  }

  function buildSnapshot() {
    const published = phase === 'published' ? engine.snapshot() : null;
    const fleetDeliveries = published ? published.fleetDeliveries.map(order => ({ ...order, assignmentUnitId: orderUnit.get(order.id) })) : [];
    const assignments = phase === 'draft' ? draftAssignments : published ? new Map(fleetDeliveries.map(order => [order.id, order.vehicleId])) : null;
    const defaults = published ? publishedDefaults(fleetDeliveries) : { defaultVehicleId: candidateIds[0] ?? vehicles[0]?.id ?? null, defaultStopId: null };
    const selectedState = published?.vehicleStates?.[defaults.defaultVehicleId] || null;
    const selectedVehicle = published?.fleetVehicles.find(vehicle => vehicle.id === defaults.defaultVehicleId) || vehicleById.get(defaults.defaultVehicleId) || null;
    const selectedDeliveries = fleetDeliveries.filter(order => order.vehicleId === defaults.defaultVehicleId);
    const base = published ? {
      ...published,
      fleetDeliveries,
      vehicle: clone(selectedVehicle),
      deliveries: selectedDeliveries,
      truck: clone(selectedState?.truck ?? null),
      phase: selectedState?.phase ?? 'idle',
      kpi: clone(selectedState?.kpi ?? {}),
      customerStopId: defaults.defaultStopId,
      scenarioPreset: selectedState?.scenarioPreset ?? null,
      scenarioStopId: selectedState?.scenarioStopId ?? null,
    } : {
      simTime: stateTimestamp,
      simClock: new Date(stateTimestamp + 9 * 60 * 60 * 1000).toISOString().slice(11, 16),
      fleetVehicles: vehicles.map(clone),
      fleetDeliveries: [],
      vehicleStates: {},
      vehicle: clone(selectedVehicle),
      deliveries: [],
      truck: null,
      phase: 'idle',
      kpi: {},
      customerStopId: null,
      scenarioPreset: null,
      scenarioStopId: null,
      speed: 0,
      device: null,
      incidents: [],
      nextStep: null,
      events: [],
      notifications: [],
    };
    return {
      ...base,
      sourceData: {
        ...(published?.sourceData || {}),
        date: day.date,
        sourceId,
        summary: clone(day.summary),
        operatingDate,
        defaultVehicleId: defaults.defaultVehicleId,
        defaultStopId: defaults.defaultStopId,
      },
      revision,
      dispatch: dispatchState(assignments),
      dispatchCandidates: vehicles.map(vehicle => ({ id: vehicle.id, driver: vehicle.driver, plate: vehicle.plate, region: vehicle.region, locked: readOnly || phase === 'published' })),
      dispatchPreview: phase === 'unplanned' ? [] : candidateIds.map(id => summaryFor(assignments, id)),
      dispatchOrders: day.orders.map(order => ({
        ...clone(order),
        originalGroupId: order.groupId,
        candidateGroupId: order.groupId,
        assignmentUnitId: orderUnit.get(order.id),
        vehicleId: assignments?.get(order.id) ?? null,
        driver: vehicleById.get(assignments?.get(order.id))?.driver || '',
      })),
      fleetDeliveries,
    };
  }

  function requireWritable() {
    if (readOnly) fail(409, 'DATE_READ_ONLY', '과거 배차일은 조회만 할 수 있습니다.');
  }

  function calculate(command) {
    if (phase === 'published') fail(409, 'DISPATCH_ALREADY_PUBLISHED', '전송한 배차는 다시 계산할 수 없습니다.');
    if (!calculator) fail(409, 'CALCULATION_UNAVAILABLE', '배차 계산 기준이 아직 준비되지 않았습니다.');
    if (!Array.isArray(command.vehicleIds) || !command.vehicleIds.length || new Set(command.vehicleIds).size !== command.vehicleIds.length
      || command.vehicleIds.some(id => !vehicleById.has(id))) fail(400, 'INVALID_CANDIDATES', '계산할 차량을 확인해 주세요.');
    const input = {
      orders: clone(day.orders),
      vehicles: clone(vehicles),
      vehicleIds: [...command.vehicleIds],
      units: clone([...units.values()]),
    };
    const calculated = calculator(input);
    if (calculated && typeof calculated.then === 'function') fail(400, 'INVALID_CALCULATOR', '동기 배차 계산 결과가 필요합니다.');
    const assignments = assignmentsFrom(calculated, orderById, vehicleById);
    if ([...assignments.values()].some(id => !command.vehicleIds.includes(id))) fail(400, 'INVALID_ASSIGNMENT', '선택한 차량에 대한 배차 결과만 사용할 수 있습니다.');
    validateUnits(assignments, units);
    draftAssignments = assignments;
    candidateIds = [...command.vehicleIds];
    phase = 'draft';
    draftVersion += 1;
    stateTimestamp = now();
    return { type: command.type, draftVersion, candidateIds: [...candidateIds], summary: clone(dispatchState(assignments).summary) };
  }

  function reassign(command) {
    if (phase === 'published') fail(409, 'DISPATCH_ALREADY_PUBLISHED', '전송한 배차는 변경할 수 없습니다.');
    if (phase !== 'draft') fail(409, 'DISPATCH_DRAFT_REQUIRED', '배차 계산 후 주문을 조정해 주세요.');
    const targetVehicleId = command.targetVehicleId ?? command.targetGroupId;
    if (!vehicleById.has(targetVehicleId)) fail(400, 'INVALID_VEHICLE', '배차 대상 차량을 확인해 주세요.');
    if (!candidateIds.includes(targetVehicleId)) fail(400, 'INVALID_CANDIDATE', '선택한 후보 차량 안에서 배차해 주세요.');
    if (!Array.isArray(command.orderIds) || !command.orderIds.length || command.orderIds.some(id => !orderById.has(id))) fail(400, 'INVALID_ORDERS', '재배정할 주문을 확인해 주세요.');
    const requestedOrderIds = [...new Set(command.orderIds)];
    const affectedUnitIds = [...new Set(requestedOrderIds.map(id => orderUnit.get(id)))];
    const expandedOrderIds = affectedUnitIds.flatMap(id => units.get(id).orderIds);
    const changedIds = expandedOrderIds.filter(id => draftAssignments.get(id) !== targetVehicleId);
    if (!changedIds.length) fail(400, 'NO_ASSIGNMENT_CHANGE', '선택한 배송지는 이미 해당 차량에 배차되어 있습니다.');
    const next = new Map(draftAssignments);
    for (const id of expandedOrderIds) next.set(id, targetVehicleId);
    validateUnits(next, units);
    draftAssignments = next;
    draftVersion += 1;
    stateTimestamp = now();
    return {
      type: command.type,
      targetVehicleId,
      requestedOrderIds,
      expandedOrderIds,
      affectedUnitIds,
      changedCount: changedIds.length,
      changedBoxes: changedIds.reduce((sum, id) => sum + orderById.get(id).boxes, 0),
      draftVersion,
      persisted: false,
    };
  }

  function publish(command) {
    if (phase === 'published') fail(409, 'DISPATCH_ALREADY_PUBLISHED', '이미 전송한 배차입니다.');
    if (phase !== 'draft' || command.draftVersion !== draftVersion) fail(409, 'DRAFT_CONFLICT', '배차 초안이 바뀌었습니다. 최신 초안을 확인해 주세요.');
    validateUnits(draftAssignments, units);
    const nextEngine = createSourceOperations(day, { sourceId, now, checkpoint: baseCheckpoint(day, sourceId, draftAssignments, now()) });
    const deliveries = nextEngine.snapshot().fleetDeliveries;
    if (deliveries.length !== day.orders.length || new Set(deliveries.map(order => order.id)).size !== day.orders.length
      || deliveries.some(order => draftAssignments.get(order.id) !== order.vehicleId)) fail(400, 'INVALID_ASSIGNMENT', '확정 배차 구성을 확인해 주세요.');
    engine = nextEngine;
    phase = 'published';
    confirmedVersion = draftVersion;
    stateTimestamp = now();
    return { type: command.type, confirmedVersion, orders: deliveries.length, destinations: units.size, boxes: day.orders.reduce((sum, order) => sum + order.boxes, 0), shared: true };
  }

  function validateRouteOrder(command) {
    if (!Array.isArray(command.order)) return;
    const current = engine.snapshot().fleetDeliveries.filter(order => order.vehicleId === command.vehicleId);
    const grouped = new Map();
    for (const order of current) {
      const id = orderUnit.get(order.id);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(order.id);
    }
    const positions = new Map(command.order.map((id, index) => [id, index]));
    for (const ids of grouped.values()) {
      if (ids.length < 2 || ids.some(id => !positions.has(id))) continue;
      const indexes = ids.map(id => positions.get(id)).sort((left, right) => left - right);
      if (indexes.some((index, place) => place && index !== indexes[place - 1] + 1)) {
        fail(400, 'DESTINATION_SPLIT', '같은 배송지의 주문 순서는 서로 붙어 있어야 합니다.');
      }
    }
  }

  function restore(saved) {
    if (saved?.schemaVersion === 1) {
      if (!Number.isInteger(saved.revision) || saved.revision <= 0) fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
      engine = createSourceOperations(day, { sourceId, now, checkpoint: saved });
      const deliveries = engine.snapshot().fleetDeliveries;
      phase = 'published';
      revision = saved.revision;
      draftVersion = 1;
      confirmedVersion = 1;
      candidateIds = [...new Set(deliveries.map(order => order.vehicleId))];
      legacyPublished = true;
      stateTimestamp = saved.stateTimestamp;
      return;
    }
    if (!saved || saved.schemaVersion !== 2 || saved.date !== day.date || saved.sourceId !== sourceId || saved.operatingDate !== operatingDate
      || !['unplanned', 'draft', 'published'].includes(saved.phase) || !Number.isInteger(saved.revision) || saved.revision < 0
      || !Number.isInteger(saved.draftVersion) || saved.draftVersion < 0 || !Number.isInteger(saved.confirmedVersion) || saved.confirmedVersion < 0
      || !Number.isFinite(saved.stateTimestamp) || !Array.isArray(saved.candidateIds) || new Set(saved.candidateIds).size !== saved.candidateIds.length
      || saved.candidateIds.some(id => !vehicleById.has(id)) || typeof saved.legacyPublished !== 'boolean') fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
    if (saved.phase === 'unplanned' && (saved.draftAssignments !== null || saved.confirmedEngineCheckpoint !== null || saved.legacyPublished)) fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
    if (saved.phase === 'draft') {
      draftAssignments = assignmentsFrom(saved.draftAssignments, orderById, vehicleById);
      validateUnits(draftAssignments, units);
      if (saved.confirmedEngineCheckpoint !== null || saved.legacyPublished || saved.draftVersion < 1 || saved.confirmedVersion !== 0 || saved.revision !== saved.draftVersion
        || !saved.candidateIds.length || [...draftAssignments.values()].some(id => !saved.candidateIds.includes(id))) {
        fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
      }
    }
    if (saved.phase === 'published') {
      if (!saved.confirmedEngineCheckpoint || saved.draftAssignments !== null || saved.draftVersion < 1 || saved.confirmedVersion !== saved.draftVersion
        || saved.revision < saved.confirmedEngineCheckpoint.revision || !saved.candidateIds.length) fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
      engine = createSourceOperations(day, { sourceId, now, checkpoint: saved.confirmedEngineCheckpoint });
      const deliveries = engine.snapshot().fleetDeliveries;
      const restoredAssignments = new Map(deliveries.map(order => [order.id, order.vehicleId]));
      if (deliveries.length !== day.orders.length || restoredAssignments.size !== day.orders.length
        || [...restoredAssignments.values()].some(id => !saved.candidateIds.includes(id))) fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
      if (!saved.legacyPublished) validateUnits(restoredAssignments, units);
    }
    if (saved.phase === 'unplanned' && (saved.revision !== 0 || saved.draftVersion !== 0 || saved.confirmedVersion !== 0 || saved.candidateIds.length)) {
      fail(400, 'INVALID_CHECKPOINT', '저장된 배차 상태를 확인해 주세요.');
    }
    phase = saved.phase;
    revision = saved.revision;
    draftVersion = saved.draftVersion;
    confirmedVersion = saved.confirmedVersion;
    candidateIds = [...saved.candidateIds];
    legacyPublished = saved.legacyPublished;
    stateTimestamp = saved.stateTimestamp;
  }

  if (checkpoint) restore(checkpoint);

  return {
    get revision() { return revision; },
    snapshot: buildSnapshot,
    exportCheckpoint() {
      return {
        schemaVersion: 2,
        date: day.date,
        sourceId,
        operatingDate,
        revision,
        phase,
        draftVersion,
        confirmedVersion,
        stateTimestamp,
        legacyPublished,
        candidateIds: [...candidateIds],
        draftAssignments: phase === 'draft' ? Object.fromEntries(draftAssignments) : null,
        confirmedEngineCheckpoint: phase === 'published' ? engine.exportCheckpoint() : null,
      };
    },
    command(command) {
      if (!command || !Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) fail(400, 'REVISION_REQUIRED', '현재 상태 revision이 필요합니다.');
      if (command.expectedRevision !== revision) fail(409, 'REVISION_CONFLICT', '배차 상태가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.');
      requireWritable();
      let result;
      if (command.type === 'calculate_dispatch') result = calculate(command);
      else if (command.type === 'publish_dispatch') result = publish(command);
      else if (command.type === 'reassign') result = reassign(command);
      else if (command.type === 'reset') fail(409, 'RESET_BLOCKED', '확정 배차와 운행 상태는 초기화할 수 없습니다.');
      else if (operationalCommands.has(command.type)) {
        if (phase !== 'published') fail(409, 'DISPATCH_NOT_PUBLISHED', '배차 전송 후 운행 상태를 변경할 수 있습니다.');
        if (command.type === 'set_route_order') validateRouteOrder(command);
        result = engine.command({ ...command, expectedRevision: engine.revision }).result;
      } else fail(400, 'INVALID_COMMAND', '지원하지 않는 배차 명령입니다.');
      revision += 1;
      return { state: buildSnapshot(), result };
    },
  };
}
