import { createDispatchFleet } from '../apps/combined/dispatch-assignment.mjs';

const scenarios = new Set(['received', 'picking', 'ready', 'shipping', 'arrived', 'completed']);
const statuses = new Set(['pending', 'current', 'done', 'skipped']);
const scenarioPhase = { received: 'idle', picking: 'preparing', ready: 'preparing', shipping: 'delivering', arrived: 'delivering', completed: 'delivering' };
const scenarioLabel = { received: '주문 접수', picking: '피킹 시작', ready: '출고 준비', shipping: '배송 출발', arrived: '배송지 도착', completed: '배송 완료' };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function plainText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text && text.length <= maxLength && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? text : null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function clockText(timestamp) {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function initialVehicleState(vehicle) {
  const [lng, lat] = vehicle.location.coordinates;
  return {
    phase: 'idle',
    scenarioPreset: 'received',
    scenarioStopId: null,
    truck: {
      lat,
      lng,
      fromId: null,
      toId: null,
      atStopId: null,
      dwelling: false,
      dwellRemaining: 0,
      locationSource: 'demo',
    },
  };
}

function customerState(status) {
  if (status === 'done') return { key: 'delivered', label: '배송 완료' };
  if (status === 'current') return { key: 'shipping', label: '배송 중' };
  if (status === 'skipped') return { key: 'held', label: '배송 보류' };
  return { key: 'paid', label: '결제 완료' };
}

export function createSourceOperations(day, { sourceId = '', now = Date.now, checkpoint = null } = {}) {
  if (typeof sourceId !== 'string' || typeof now !== 'function') fail(400, '자료 식별자와 시계를 확인해 주세요.');
  if (!validDate(day?.date)) fail(400, '배차 날짜를 확인해 주세요.');
  let fleet;
  try { fleet = createDispatchFleet(day); } catch (error) { fail(400, error.message || '배차 자료를 확인해 주세요.'); }
  const vehicles = fleet.map(vehicle => ({ ...vehicle, live: true, operationsSource: 'local' }));
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const initialLocations = new Map(vehicles.map(vehicle => [vehicle.id, clone(vehicle.location)]));
  const orderById = new Map();
  const routes = new Map(vehicles.map(vehicle => [vehicle.id, []]));
  for (const source of day.orders) {
    const order = {
      ...clone(source),
      originalGroupId: source.groupId,
      vehicleId: source.groupId,
      status: 'pending',
      customerRequests: null,
      items: [],
      eta: null,
      tip: null,
      customerStage: null,
      arrivedAt: null,
      completedAt: null,
    };
    orderById.set(order.id, order);
    routes.get(order.vehicleId).push(order.id);
  }
  for (const route of routes.values()) route.sort((left, right) => (orderById.get(left).sequence ?? 0) - (orderById.get(right).sequence ?? 0));
  const initialRoutes = new Map([...routes].map(([id, route]) => [id, [...route]]));

  const readableName = value => typeof value === 'string' && value.trim().length >= 4
    && !/^\s*(?:\d+층|\d+호|지하\s*\d*층|문\s*앞|실내|냉장고)\s*$/u.test(value);
  const candidates = vehicles.filter(vehicle => routes.get(vehicle.id).length);
  const readableCandidates = candidates.filter(vehicle => {
    const orders = routes.get(vehicle.id).map(id => orderById.get(id));
    return orders.every(order => Array.isArray(order.coordinates) && order.coordinates.length === 2 && order.coordinates.every(Number.isFinite))
      && orders.filter(order => readableName(order.name)).length >= Math.ceil(orders.length / 2);
  });
  // Prefer a readable, fully mapped real route, then choose the one nearest 35 stops / 70 boxes.
  const defaultVehicleId = (readableCandidates.length ? readableCandidates : candidates).sort((left, right) => {
    const score = vehicle => Math.abs(routes.get(vehicle.id).length - 35) * 2
      + Math.abs(routes.get(vehicle.id).reduce((sum, id) => sum + orderById.get(id).boxes, 0) - 70);
    return score(left) - score(right) || left.id.localeCompare(right.id);
  })[0]?.id ?? vehicles[0]?.id ?? null;
  const defaultStopId = routes.get(defaultVehicleId)?.map(id => orderById.get(id))
    .find(order => Array.isArray(order.coordinates) && readableName(order.name))?.id
    ?? routes.get(defaultVehicleId)?.[0] ?? null;
  const states = new Map(vehicles.map(vehicle => [vehicle.id, initialVehicleState(vehicle)]));
  const initialStates = new Map([...states].map(([id, state]) => [id, clone(state)]));
  const initialAssignments = new Map([...orderById].map(([id, order]) => [id, order.vehicleId]));
  const events = [];
  const notifications = [];
  let nextEventId = 1;
  let nextNoticeId = 1;
  let revision = 0;
  let stateTimestamp = now();

  function kpiFor(vehicleId) {
    const orders = routes.get(vehicleId).map(id => orderById.get(id));
    const done = orders.filter(order => order.status === 'done');
    return {
      stopsTotal: orders.length,
      stopsDone: done.length,
      stopsRemaining: orders.filter(order => order.status !== 'done').length,
      boxesTotal: orders.reduce((sum, order) => sum + order.boxes, 0),
      boxesDelivered: done.reduce((sum, order) => sum + order.boxes, 0),
      boxesRemaining: orders.filter(order => order.status !== 'done').reduce((sum, order) => sum + order.boxes, 0),
    };
  }

  function delivery(order, index) {
    const vehicle = vehicleById.get(order.vehicleId);
    const { customerStage: _customerStage, ...sourceOrder } = clone(order);
    const customerStatus = order.customerStage === 'picking' ? { key: 'picking', label: '피킹 중' }
      : order.customerStage === 'ready' ? { key: 'staged', label: '출고 준비' }
        : order.customerStage === 'arrived' ? { key: 'arrived', label: '배송지 도착' }
          : customerState(order.status);
    return {
      ...sourceOrder,
      sequence: index + 1,
      driver: vehicle.driver,
      statusTone: order.status === 'done' ? 'green' : order.status === 'current' ? 'blue' : 'neutral',
      customerStatus,
      customerStatusTone: order.status === 'done' ? 'green' : order.status === 'current' ? 'blue' : order.status === 'skipped' ? 'amber' : 'neutral',
      ordered: true,
      officialEta: null,
      calculatedEta: null,
      arrivedAt: Number.isFinite(order.arrivedAt) ? clockText(order.arrivedAt) : null,
      completedAt: Number.isFinite(order.completedAt) ? clockText(order.completedAt) : null,
      timeline: events.filter(event => event.stopId === order.id).map(event => ({ label: event.message.replace(`${order.name} `, ''), time: event.time, state: order.status === 'done' ? 'done' : 'current' })),
      preciseTimeText: null,
      customerWindowText: null,
      customerWindowStart: null,
      customerWindowEnd: null,
      vehicle: clone(vehicle),
      notices: notifications.filter(notice => notice.stopId === order.id).map(publicNotice),
      tip: order.tip ? { ...clone(order.tip), updatedAt: clockText(order.tip.updatedAt) } : null,
    };
  }

  function deliveriesFor(vehicleId) {
    return routes.get(vehicleId).map((id, index) => delivery(orderById.get(id), index));
  }

  function stateFor(vehicleId) {
    const state = states.get(vehicleId);
    return { ...clone(state), kpi: kpiFor(vehicleId) };
  }

  function buildSnapshot() {
    const defaultRoute = defaultVehicleId ? routes.get(defaultVehicleId) : [];
    const selectedState = defaultVehicleId ? stateFor(defaultVehicleId) : { phase: 'idle', scenarioPreset: null, scenarioStopId: null, truck: null, kpi: {} };
    const fleetDeliveries = vehicles.flatMap(vehicle => deliveriesFor(vehicle.id));
    return {
      sourceData: {
        date: day.date,
        sourceId,
        summary: clone(day.summary),
        defaultVehicleId,
        defaultStopId,
      },
      revision,
      simTime: stateTimestamp,
      simClock: clockText(stateTimestamp),
      fleetVehicles: vehicles.map(clone),
      fleetDeliveries,
      vehicleStates: Object.fromEntries(vehicles.map(vehicle => [vehicle.id, stateFor(vehicle.id)])),
      vehicle: clone(vehicleById.get(defaultVehicleId) || null),
      deliveries: defaultVehicleId ? deliveriesFor(defaultVehicleId) : [],
      truck: selectedState.truck,
      phase: selectedState.phase,
      kpi: selectedState.kpi,
      customerStopId: defaultStopId,
      scenarioPreset: selectedState.scenarioPreset,
      scenarioStopId: selectedState.scenarioStopId,
      speed: 0,
      device: null,
      incidents: [],
      nextStep: null,
      events: [...events].reverse().map(clone),
      notifications: notifications.map(publicNotice),
    };
  }

  function requireVehicle(vehicleId) {
    if (!vehicleById.has(vehicleId)) fail(400, '차량을 확인해 주세요.');
    return vehicleId;
  }

  function requireStop(stopId, vehicleId = null) {
    const order = orderById.get(stopId);
    if (!order || (vehicleId && order.vehicleId !== vehicleId)) fail(400, '배송지를 확인해 주세요.');
    return order;
  }

  function record(action, vehicleId, stopId, message, type = 'driver', metadata = {}) {
    stateTimestamp = now();
    events.push({ id: nextEventId++, ts: stateTimestamp, time: clockText(stateTimestamp), vehicleId, ...(stopId ? { stopId } : {}), action, type, message, ...metadata });
  }

  function eventMessage(action, vehicleId, stopId, event = {}) {
    const order = orderById.get(stopId);
    if (order && scenarioLabel[action]) return `${order.name} ${scenarioLabel[action]}`;
    if (order && action === 'toggle_skip') return `${order.name} ${event.status === 'skipped' ? '배송 보류' : '배송 보류 해제'}`;
    if (order && action === 'delivery_tip') return `${order.name} 배송 팁 수정`;
    if (order && action === 'customer_notice') return `${order.name} 고객 안내 기록`;
    if (action === 'route_order') return `${vehicleById.get(vehicleId)?.driver || '배송원'} 배송 순서 변경`;
    if (action === 'reassign') return '배차 변경';
    return '배송 상태 변경';
  }

  function notify(vehicleId, order, title, body, kind) {
    const ts = now();
    notifications.push({
      id: nextNoticeId++, ts, time: clockText(ts), clock: clockText(ts), stopId: order.id,
      title, body, kind, channel: '고객 팝업', status: '기록', author: '운영자', _template: kind,
    });
  }

  function publicNotice(notice) {
    const { _template, ...visible } = notice;
    return clone(visible);
  }

  function scenarioNotice(order, scenario) {
    return {
      received: ['주문 접수 완료', `${order.name} 주문 접수가 확인되었습니다.`],
      picking: ['상품 준비 중', `${order.name} 주문 상품을 준비하고 있습니다.`],
      ready: ['출고 준비 완료', `${order.name} 주문의 출고 준비가 완료되었습니다.`],
      shipping: ['배송 출발', `${order.name} 배송이 출발했습니다.`],
      arrived: ['배송지 도착', `${order.name} 배송이 도착했습니다.`],
      completed: ['배송 완료', `${order.name} 배송이 완료되었습니다.`],
    }[scenario];
  }

  function pointFor(order, vehicle) {
    const coordinates = Array.isArray(order?.coordinates) ? order.coordinates : vehicle.location.coordinates;
    return { lng: coordinates[0], lat: coordinates[1] };
  }

  function makeCurrent(vehicleId, stopId, arrived = false) {
    const target = requireStop(stopId, vehicleId);
    if (target.status === 'done') fail(400, '완료된 배송지는 다시 진행할 수 없습니다.');
    for (const id of routes.get(vehicleId)) {
      const previous = orderById.get(id);
      if (id !== stopId && previous.status === 'current') { previous.status = 'pending'; previous.customerStage = null; }
    }
    target.status = 'current';
    target.customerStage = arrived ? 'arrived' : 'shipping';
    const vehicle = vehicleById.get(vehicleId);
    const point = pointFor(target, vehicle);
    vehicle.location = { coordinates: [point.lng, point.lat], label: '배송지 인근 예시 위치', source: 'demo' };
    Object.assign(states.get(vehicleId).truck, {
      ...point,
      fromId: arrived ? stopId : null,
      toId: arrived ? null : stopId,
      atStopId: arrived ? stopId : null,
      dwelling: arrived,
      dwellRemaining: arrived ? null : 0,
      locationSource: 'demo',
    });
    return target;
  }

  function setScenario(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    if (!scenarios.has(command.scenario)) fail(400, '시나리오 상태를 확인해 주세요.');
    if (command.scenario === 'completed') fail(400, '배송은 사진 확인 후 배송 완료 버튼으로만 완료할 수 있습니다.');
    if (order.status === 'done') fail(400, '완료된 배송지의 상태는 바꿀 수 없습니다.');
    const state = states.get(vehicleId);
    if (state.scenarioPreset === command.scenario && state.scenarioStopId === order.id) fail(400, '이미 선택한 상태입니다.');
    if (['received', 'picking', 'ready'].includes(command.scenario)) {
      for (const id of routes.get(vehicleId)) {
        const previous = orderById.get(id);
        if (previous.status === 'current') { previous.status = 'pending'; previous.customerStage = null; }
      }
      states.set(vehicleId, { ...initialVehicleState(vehicleById.get(vehicleId)), phase: scenarioPhase[command.scenario], scenarioPreset: command.scenario, scenarioStopId: order.id });
      order.customerStage = command.scenario === 'received' ? null : command.scenario;
    }
    if (command.scenario === 'shipping') makeCurrent(vehicleId, order.id, false);
    if (command.scenario === 'arrived') {
      makeCurrent(vehicleId, order.id, true);
      order.arrivedAt = now();
    }
    state.phase = scenarioPhase[command.scenario];
    state.scenarioPreset = command.scenario;
    state.scenarioStopId = order.id;
    const [title, body] = scenarioNotice(order, command.scenario);
    notify(vehicleId, order, title, body, command.scenario);
    record(command.scenario, vehicleId, order.id, `${order.name} ${scenarioLabel[command.scenario]}`, 'stage');
    return { type: command.type, vehicleId, stopId: order.id, scenario: command.scenario };
  }

  function arrive(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    const state = states.get(vehicleId);
    if (state.phase !== 'delivering' || order.status !== 'current' || state.truck.toId !== order.id || state.truck.dwelling) fail(400, '현재 이동 중인 배송지만 도착 처리할 수 있습니다.');
    makeCurrent(vehicleId, order.id, true);
    order.arrivedAt = now();
    state.scenarioPreset = 'arrived'; state.scenarioStopId = order.id;
    notify(vehicleId, order, ...scenarioNotice(order, 'arrived'), 'arrived');
    record('arrived', vehicleId, order.id, `${order.name} 배송지 도착`, 'stage');
    return { type: command.type, vehicleId, stopId: order.id };
  }

  function complete(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    const state = states.get(vehicleId);
    if (command.hasPhoto !== true) fail(400, '사진 확인 후 배송을 완료해 주세요.');
    if (Array.isArray(command.confirmedRequestIds) && command.confirmedRequestIds.length) fail(400, '이 주문에는 확인할 고객 요청이 없습니다.');
    if (state.phase !== 'delivering' || order.status !== 'current' || state.truck.atStopId !== order.id || !state.truck.dwelling) fail(400, '도착한 현재 배송지만 완료할 수 있습니다.');
    order.status = 'done';
    order.customerStage = 'completed';
    order.completedAt = now();
    const nextId = routes.get(vehicleId).find(id => orderById.get(id).status === 'pending');
    if (nextId) {
      const next = orderById.get(nextId);
      next.status = 'current';
      next.customerStage = 'shipping';
      const point = pointFor(order, vehicleById.get(vehicleId));
      Object.assign(state.truck, { ...point, fromId: order.id, toId: nextId, atStopId: null, dwelling: false, dwellRemaining: 0, locationSource: 'demo' });
      state.phase = 'delivering';
    } else {
      Object.assign(state.truck, { fromId: order.id, toId: null, atStopId: order.id, dwelling: false, dwellRemaining: 0 });
      state.phase = routes.get(vehicleId).every(id => orderById.get(id).status === 'done') ? 'done' : 'delivering';
    }
    state.scenarioPreset = 'completed'; state.scenarioStopId = order.id;
    notify(vehicleId, order, ...scenarioNotice(order, 'completed'), 'completed');
    record('completed', vehicleId, order.id, `${order.name} 배송 완료`, 'stage');
    return { type: command.type, vehicleId, stopId: order.id, nextStopId: nextId || null };
  }

  function reorder(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const current = routes.get(vehicleId);
    if (!Array.isArray(command.order) || command.order.length !== current.length || new Set(command.order).size !== current.length || command.order.some(id => !current.includes(id))) fail(400, '배송 순서를 확인해 주세요.');
    if (!Array.isArray(command.expectedOrder) || !Array.isArray(command.expectedStatuses)
      || command.expectedOrder.length !== current.length || command.expectedStatuses.length !== current.length
      || command.expectedStatuses.some(status => !statuses.has(status))
      || !['idle', 'preparing', 'delivering', 'done'].includes(command.expectedPhase)) fail(400, '배송 순서 기준 상태를 확인해 주세요.');
    const actualStatuses = current.map(id => orderById.get(id).status);
    const state = states.get(vehicleId);
    if (command.expectedPhase !== state.phase || command.expectedOrder.some((id, index) => id !== current[index]) || command.expectedStatuses.some((status, index) => status !== actualStatuses[index])) fail(409, '배송 상태가 바뀌었습니다. 다시 확인해 주세요.');
    if (current.some((id, index) => orderById.get(id).status !== 'pending' && command.order[index] !== id)) fail(400, '현재, 완료 또는 보류 배송지는 순서를 바꿀 수 없습니다.');
    if (current.every((id, index) => id === command.order[index])) fail(400, '변경된 배송 순서가 없습니다.');
    routes.set(vehicleId, [...command.order]);
    record('route_order', vehicleId, null, `${vehicleById.get(vehicleId).driver} 배송 순서 변경`);
    return { type: command.type, vehicleId, order: [...command.order] };
  }

  function toggleSkip(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    if (!['pending', 'skipped'].includes(order.status)) fail(400, '대기 중인 배송지만 보류할 수 있습니다.');
    order.status = order.status === 'skipped' ? 'pending' : 'skipped';
    order.customerStage = null;
    record('toggle_skip', vehicleId, order.id, `${order.name} ${order.status === 'skipped' ? '배송 보류' : '배송 보류 해제'}`, 'driver', { status: order.status });
    return { type: command.type, vehicleId, stopId: order.id, status: order.status };
  }

  function setTip(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    const body = plainText(command.body, 500);
    if (!body) fail(400, '배송 팁 내용을 확인해 주세요.');
    if (order.status === 'done') fail(400, '완료된 배송지의 팁은 바꿀 수 없습니다.');
    if (order.tip?.body === body) fail(400, '변경된 배송 팁이 없습니다.');
    order.tip = { body, author: vehicleById.get(vehicleId).driver, updatedAt: now() };
    record('delivery_tip', vehicleId, order.id, `${order.name} 배송 팁 수정`);
    return { type: command.type, vehicleId, stopId: order.id };
  }

  function sendNotice(command) {
    const vehicleId = requireVehicle(command.vehicleId);
    const order = requireStop(command.stopId, vehicleId);
    const body = plainText(command.body, 300);
    if (!body) fail(400, '고객 안내 내용을 확인해 주세요.');
    const ts = now();
    const notice = { id: nextNoticeId++, ts, time: clockText(ts), clock: clockText(ts), stopId: order.id, title: '운영자 안내', body, kind: 'manual', channel: '고객 팝업', status: '기록', author: plainText(command.author, 80) || '운영자' };
    notifications.push(notice);
    record('customer_notice', vehicleId, order.id, `${order.name} 고객 안내 기록`, 'notify');
    return { type: command.type, vehicleId, stopId: order.id, noticeId: notice.id, status: notice.status };
  }

  function reassign(command) {
    const targetVehicleId = requireVehicle(command.targetVehicleId ?? command.targetGroupId);
    if (!Array.isArray(command.orderIds) || !command.orderIds.length) fail(400, '재배정할 주문을 선택해 주세요.');
    const ids = [...new Set(command.orderIds)];
    const orders = ids.map(id => requireStop(id));
    if (orders.some(order => order.vehicleId === targetVehicleId)) fail(400, '선택한 주문 중 대상 차량에 이미 배차된 주문이 있습니다.');
    if (orders.some(order => ['current', 'done'].includes(order.status))) fail(400, '현재 또는 완료 배송지는 재배정할 수 없습니다.');
    for (const order of orders) {
      const previousVehicleId = order.vehicleId;
      routes.set(order.vehicleId, routes.get(order.vehicleId).filter(id => id !== order.id));
      order.vehicleId = targetVehicleId;
      order.customerStage = null;
      if (states.get(previousVehicleId).scenarioStopId === order.id) states.set(previousVehicleId, initialVehicleState(vehicleById.get(previousVehicleId)));
    }
    routes.get(targetVehicleId).push(...ids);
    if (states.get(targetVehicleId).phase === 'done') states.set(targetVehicleId, initialVehicleState(vehicleById.get(targetVehicleId)));
    record('reassign', targetVehicleId, ids.length === 1 ? ids[0] : null, '배차 변경');
    return { type: command.type, targetVehicleId, changedCount: ids.length, changedBoxes: orders.reduce((sum, order) => sum + order.boxes, 0), persisted: false };
  }

  function reset() {
    const changed = events.length || notifications.length || [...orderById].some(([id, order]) => order.vehicleId !== initialAssignments.get(id) || order.status !== 'pending' || order.tip !== null)
      || [...states.values()].some(state => state.phase !== 'idle' || state.scenarioPreset !== 'received' || state.scenarioStopId !== null);
    if (!changed) fail(400, '초기화할 변경이 없습니다.');
    for (const route of routes.values()) route.length = 0;
    for (const [id, order] of orderById) {
      order.vehicleId = initialAssignments.get(id); order.status = 'pending'; order.tip = null; order.customerStage = null; order.arrivedAt = null; order.completedAt = null;
      routes.get(order.vehicleId).push(id);
    }
    for (const route of routes.values()) route.sort((left, right) => (orderById.get(left).sequence ?? 0) - (orderById.get(right).sequence ?? 0));
    for (const vehicle of vehicles) {
      vehicle.location = clone(initialLocations.get(vehicle.id));
      states.set(vehicle.id, initialVehicleState(vehicle));
    }
    events.length = 0; notifications.length = 0;
    stateTimestamp = now();
    return { type: 'reset' };
  }

  function exportCheckpoint() {
    const changedRoutes = {};
    for (const [vehicleId, route] of routes) {
      const initial = initialRoutes.get(vehicleId);
      if (route.length !== initial.length || route.some((id, index) => id !== initial[index])) changedRoutes[vehicleId] = [...route];
    }
    const changedOrders = {};
    for (const [id, order] of orderById) {
      const change = {};
      if (order.vehicleId !== initialAssignments.get(id)) change.vehicleId = order.vehicleId;
      if (order.status !== 'pending') change.status = order.status;
      if (order.customerStage !== null) change.customerStage = order.customerStage;
      if (order.tip !== null) change.tip = clone(order.tip);
      if (order.arrivedAt !== null) change.arrivedAt = order.arrivedAt;
      if (order.completedAt !== null) change.completedAt = order.completedAt;
      if (Object.keys(change).length) changedOrders[id] = change;
    }
    const changedStates = {};
    for (const [vehicleId, state] of states) {
      const location = vehicleById.get(vehicleId).location;
      if (JSON.stringify(state) !== JSON.stringify(initialStates.get(vehicleId)) || JSON.stringify(location) !== JSON.stringify(initialLocations.get(vehicleId))) {
        changedStates[vehicleId] = { ...clone(state), vehicleLocation: clone(location) };
      }
    }
    return {
      schemaVersion: 1,
      date: day.date,
      sourceId,
      revision,
      stateTimestamp,
      nextEventId,
      nextNoticeId,
      routes: changedRoutes,
      orders: changedOrders,
      states: changedStates,
      events: events.map(({ message: _message, time: _time, ...event }) => clone(event)),
      notices: notifications.map(notice => notice._template
        ? { id: notice.id, ts: notice.ts, stopId: notice.stopId, template: notice._template }
        : (({ time: _time, clock: _clock, ...savedNotice }) => clone(savedNotice))(publicNotice(notice))),
    };
  }

  function restoreCheckpoint(saved) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(saved) || saved.schemaVersion !== 1 || saved.date !== day.date || saved.sourceId !== sourceId
      || !Number.isInteger(saved.revision) || saved.revision < 0 || !Number.isFinite(saved.stateTimestamp)
      || !Number.isInteger(saved.nextEventId) || saved.nextEventId < 1 || !Number.isInteger(saved.nextNoticeId) || saved.nextNoticeId < 1
      || !object(saved.routes) || !object(saved.orders) || !object(saved.states) || !Array.isArray(saved.events) || !Array.isArray(saved.notices)) {
      fail(400, '저장된 운행 상태를 확인해 주세요.');
    }

    const restoredRoutes = new Map([...initialRoutes].map(([id, route]) => [id, [...route]]));
    for (const [vehicleId, route] of Object.entries(saved.routes)) {
      if (!vehicleById.has(vehicleId) || !Array.isArray(route) || new Set(route).size !== route.length || route.some(id => !orderById.has(id))) fail(400, '저장된 배차 순서를 확인해 주세요.');
      restoredRoutes.set(vehicleId, [...route]);
    }
    const restoredOrders = new Map();
    for (const [id, change] of Object.entries(saved.orders)) {
      if (!orderById.has(id) || !object(change) || Object.keys(change).some(key => !['vehicleId', 'status', 'customerStage', 'tip', 'arrivedAt', 'completedAt'].includes(key))) fail(400, '저장된 주문 상태를 확인해 주세요.');
      const vehicleId = change.vehicleId ?? initialAssignments.get(id);
      if (!vehicleById.has(vehicleId) || (change.status !== undefined && !statuses.has(change.status))
        || (change.customerStage !== undefined && ![null, 'picking', 'ready', 'shipping', 'arrived', 'completed'].includes(change.customerStage))
        || (change.arrivedAt !== undefined && !Number.isFinite(change.arrivedAt)) || (change.completedAt !== undefined && !Number.isFinite(change.completedAt))
        || (change.tip !== undefined && (!object(change.tip) || typeof change.tip.body !== 'string' || typeof change.tip.author !== 'string' || !Number.isFinite(change.tip.updatedAt)))) {
        fail(400, '저장된 주문 상태를 확인해 주세요.');
      }
      restoredOrders.set(id, { ...change, vehicleId });
    }
    const allRouteIds = [...restoredRoutes.values()].flat();
    if (allRouteIds.length !== orderById.size || new Set(allRouteIds).size !== orderById.size
      || allRouteIds.some(id => !orderById.has(id))) fail(400, '저장된 배차 구성을 확인해 주세요.');
    for (const [vehicleId, route] of restoredRoutes) {
      if (route.some(id => (restoredOrders.get(id)?.vehicleId ?? initialAssignments.get(id)) !== vehicleId)) fail(400, '저장된 배차 구성을 확인해 주세요.');
    }

    const restoredStates = new Map([...initialStates].map(([id, state]) => [id, clone(state)]));
    for (const [vehicleId, savedState] of Object.entries(saved.states)) {
      if (!vehicleById.has(vehicleId) || !object(savedState) || !object(savedState.truck) || !object(savedState.vehicleLocation)
        || !['idle', 'preparing', 'delivering', 'done'].includes(savedState.phase)
        || (savedState.scenarioPreset !== null && !scenarios.has(savedState.scenarioPreset))
        || (savedState.scenarioStopId !== null && !orderById.has(savedState.scenarioStopId))
        || !Number.isFinite(savedState.truck.lat) || !Number.isFinite(savedState.truck.lng)
        || !Array.isArray(savedState.vehicleLocation.coordinates) || savedState.vehicleLocation.coordinates.length !== 2 || !savedState.vehicleLocation.coordinates.every(Number.isFinite)
        || savedState.vehicleLocation.source !== 'demo') fail(400, '저장된 차량 상태를 확인해 주세요.');
      if (savedState.scenarioStopId && (restoredOrders.get(savedState.scenarioStopId)?.vehicleId ?? initialAssignments.get(savedState.scenarioStopId)) !== vehicleId) fail(400, '저장된 차량 상태를 확인해 주세요.');
      const { vehicleLocation, ...state } = savedState;
      restoredStates.set(vehicleId, clone(state));
      vehicleById.get(vehicleId).location = clone(vehicleLocation);
    }

    const restoredEvents = saved.events.map(event => {
      if (!object(event) || !Number.isInteger(event.id) || !Number.isFinite(event.ts) || typeof event.action !== 'string' || typeof event.type !== 'string'
        || !vehicleById.has(event.vehicleId) || (event.stopId !== undefined && !orderById.has(event.stopId))) fail(400, '저장된 사건 이력을 확인해 주세요.');
      const { id, ts, vehicleId, stopId, action, type, ...metadata } = event;
      return { id, ts, time: clockText(ts), vehicleId, ...(stopId ? { stopId } : {}), action, type, message: eventMessage(action, vehicleId, stopId, event), ...clone(metadata) };
    });
    const restoredNotices = saved.notices.map(notice => {
      if (!object(notice) || !Number.isInteger(notice.id) || !Number.isFinite(notice.ts) || !orderById.has(notice.stopId)) fail(400, '저장된 고객 알림을 확인해 주세요.');
      const order = orderById.get(notice.stopId);
      if (notice.template) {
        if (!scenarios.has(notice.template)) fail(400, '저장된 고객 알림을 확인해 주세요.');
        const [title, body] = scenarioNotice(order, notice.template);
        return { id: notice.id, ts: notice.ts, time: clockText(notice.ts), clock: clockText(notice.ts), stopId: notice.stopId, title, body, kind: notice.template, channel: '고객 팝업', status: '기록', author: '운영자', _template: notice.template };
      }
      if (typeof notice.title !== 'string' || typeof notice.body !== 'string' || typeof notice.kind !== 'string' || typeof notice.status !== 'string') fail(400, '저장된 고객 알림을 확인해 주세요.');
      const { id, ts, stopId, title, body, kind, channel, status, author } = notice;
      return { id, ts, time: clockText(ts), clock: clockText(ts), stopId, title, body, kind, channel, status, author };
    });

    routes.clear(); for (const [id, route] of restoredRoutes) routes.set(id, route);
    for (const [id, change] of restoredOrders) Object.assign(orderById.get(id), clone(change));
    states.clear(); for (const [id, state] of restoredStates) states.set(id, state);
    events.push(...restoredEvents); notifications.push(...restoredNotices);
    revision = saved.revision; stateTimestamp = saved.stateTimestamp;
    nextEventId = saved.nextEventId; nextNoticeId = saved.nextNoticeId;
  }

  const handlers = { set_scenario: setScenario, arrive_stop: arrive, complete_stop: complete, set_route_order: reorder, toggle_skip: toggleSkip, set_delivery_tip: setTip, send_customer_notice: sendNotice, reassign };
  if (checkpoint) restoreCheckpoint(checkpoint);
  return {
    get revision() { return revision; },
    snapshot() { return buildSnapshot(); },
    exportCheckpoint,
    command(command) {
      if (!command || !Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) fail(400, '현재 상태 revision이 필요합니다.');
      if (command.expectedRevision !== revision) fail(409, '운행 상태가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.');
      const result = command.type === 'reset' ? reset() : handlers[command.type]?.(command);
      if (!result) fail(400, '지원하지 않는 운행 명령입니다.');
      revision += 1;
      return { state: buildSnapshot(), result };
    },
  };
}
