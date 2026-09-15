'use strict';

const { Simulation: OriginalSimulation } = require('../workspaces/sanghyun-scenario/src/simulation');
const routeData = require('../workspaces/sanghyun-scenario/src/route-data');
const { LIVE_BOXES, makeFleetData } = require('./fleet-data');
const { vehicleTiming } = require('./vehicle-timing');
const { exampleRequestsFor, validRequestConfirmation } = require('./customer-requests');

const MIN = 60 * 1000;
const MAX_NOTICE_LENGTH = 300;
const MAX_TIP_LENGTH = 500;
const MAX_NOTICES = 1_000;
const MAX_NOTICES_PER_STOP = 50;
const LIVE_VEHICLE = { id: 'V1', plate: '서울87바 1234', driver: '김민수', region: '송파·강남 4권역', live: true };
const SCENARIOS = new Set(['received', 'picking', 'ready', 'shipping', 'arrived', 'completed']);
const SCENARIO_LABELS = { received: '주문 접수 완료', picking: '피킹 시작', ready: '출고 준비 완료', shipping: '배송 출발', arrived: '도착', completed: '배송 완료' };
const PREP = {
  picking: { key: 'picking', label: '피킹 중', at: (5 * 60 + 50) * MIN },
  labeling: { key: 'labeling', label: '라벨 부착', at: (6 * 60 + 5) * MIN },
  staged: { key: 'staged', label: '상차 대기', at: (6 * 60 + 20) * MIN },
  departed: { key: 'departed', label: '배송 출발', at: (6 * 60 + 30) * MIN },
};

const formatTime = ms => {
  const minutes = Math.round(ms / MIN);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const windowFor = arrival => ({
  start: formatTime(arrival - 30 * MIN),
  end: formatTime(arrival + 30 * MIN),
  text: `${formatTime(arrival - 30 * MIN)} ~ ${formatTime(arrival + 30 * MIN)}`,
});

function normalizePlainText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function validPlainText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const normalized = normalizePlainText(value);
  return normalized.length > 0 && normalized.length <= maxLength
    && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized);
}

class OperatingSimulation extends OriginalSimulation {
  constructor(broadcast) {
    super(broadcast);
    clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    const nextNotificationId = this.nextNotificationId || 1;
    this.operatingResetting = true;
    super.reset();
    this.nextNotificationId = nextNotificationId;
    this.phase = 'idle';
    this.orderedAt = this.simTime;
    this.order.forEach((id, index) => { this.stops[id].boxes = LIVE_BOXES[index]; });
    this.fleet = makeFleetData(LIVE_VEHICLE);
    this.customerPromises = new Map();
    this.deliveryTips = new Map();
    this.scenarioPreset = 'received';
    this.scenarioStopId = 'S1';
    this.notifications = [];
    this.events = [];
    this.officialEtas = {};
    this.operatingResetting = false;
    this.recalcEtas('초기 안내', { silent: true });
    this.logEvent('주문 접수 완료', 'stage');
    this.emit();
  }

  emit() {
    if (!this.operatingResetting) super.emit();
  }

  placeOrder() {
    return false;
  }

  advance() { return false; }
  setSpeed() { return false; }
  tick() { return false; }

  timelineFor(id) {
    const orderedTime = formatTime(this.orderedAt ?? this.simTime);
    return super.timelineFor(id).map(item => ['주문 접수', '결제 완료'].includes(item.label)
      ? { ...item, time: orderedTime }
      : item);
  }

  customerStatusFor(id) {
    if (id === this.scenarioStopId && this.scenarioPreset === 'shipping') return { key: 'shipping', label: '배송 중' };
    return super.customerStatusFor(id);
  }

  setScenario(scenario, stopId) {
    if (!SCENARIOS.has(scenario) || typeof stopId !== 'string' || !this.stops?.[stopId]) return false;
    if (this.scenarioPreset === scenario && this.scenarioStopId === stopId) return false;

    const selectedIndex = this.order.indexOf(stopId);
    const selectedArrival = (6 * 60 + 34 + selectedIndex * 10) * MIN;
    const prepDone = scenario === 'received' ? []
      : scenario === 'picking' ? [PREP.picking]
        : scenario === 'ready' ? [PREP.picking, PREP.labeling, PREP.staged]
          : [PREP.picking, PREP.labeling, PREP.staged, PREP.departed];
    this.phase = scenario === 'received' ? 'idle'
      : ['picking', 'ready'].includes(scenario) ? 'preparing'
        : scenario === 'completed' && selectedIndex === this.order.length - 1 ? 'done'
          : 'delivering';
    this.simTime = scenario === 'received' ? (5 * 60 + 45) * MIN
      : scenario === 'picking' ? PREP.picking.at
        : scenario === 'ready' ? PREP.staged.at
          : scenario === 'shipping' ? selectedArrival - 4 * MIN
            : scenario === 'arrived' ? selectedArrival
              : selectedArrival + MIN;
    this.prepDone = prepDone.map(item => ({ ...item }));
    this.latestEtas = {};
    this.frozenEtas = {};
    this.legFactors = {};
    this.globalFactor = 1;
    this.extraDwellQueued = 0;
    this.incidents = [];
    this.nearbyNotified = new Set();
    this.truck = this.makeIdleTruck();
    for (const id of this.order) {
      this.stops[id].status = 'pending';
      this.stops[id].arrivedAt = null;
      this.stops[id].deliveredAt = null;
    }

    if (['shipping', 'arrived', 'completed'].includes(scenario)) {
      for (let index = 0; index < selectedIndex; index++) this.markPresetDone(index);
      const selected = this.stops[stopId];
      const fromId = selectedIndex ? this.order[selectedIndex - 1] : 'MFC';
      const fromPoint = routeData.points.find(point => point.id === fromId);
      if (scenario === 'shipping') {
        selected.status = 'current';
        Object.assign(this.truck, { lat: fromPoint.lat, lng: fromPoint.lng, fromId, toId: stopId, progress: 0, dwellRemaining: 0, atStopId: null });
      } else {
        const point = routeData.points.find(item => item.id === stopId);
        selected.arrivedAt = selectedArrival;
        this.frozenEtas[stopId] = selectedArrival;
        Object.assign(this.truck, { lat: point.lat, lng: point.lng, fromId: stopId, toId: null, progress: 0, dwellRemaining: scenario === 'arrived' ? 240 : 0, atStopId: stopId });
        if (scenario === 'arrived') selected.status = 'current';
        else {
          selected.status = 'done';
          selected.deliveredAt = this.simTime;
          const nextId = this.order[selectedIndex + 1];
          if (nextId) {
            this.stops[nextId].status = 'current';
            Object.assign(this.truck, { fromId: stopId, toId: nextId, atStopId: null });
          }
        }
      }
    }

    this.scenarioPreset = scenario;
    this.scenarioStopId = stopId;
    this.recalcEtas('수동 시나리오 고정', { silent: true });
    if (['arrived', 'completed'].includes(scenario)) {
      if (!this.customerPromises.has(stopId)) this.customerPromises.set(stopId, { arrival: selectedArrival, window: windowFor(selectedArrival) });
      this.officialEtas[stopId] = { arrival: selectedArrival, time: selectedArrival, reason: SCENARIO_LABELS[scenario], deltaMin: 0, updatedAt: this.simTime };
    }
    this.addScenarioNotice(scenario, stopId);
    this.recordDeliveryEvent(`${this.stops[stopId].name} ${SCENARIO_LABELS[scenario]}`, 'stage', stopId, { action: scenario });
    this.emit();
    return true;
  }

  markPresetDone(index) {
    const id = this.order[index];
    const arrival = (6 * 60 + 34 + index * 10) * MIN;
    this.stops[id].status = 'done';
    this.stops[id].arrivedAt = arrival;
    this.stops[id].deliveredAt = arrival + MIN;
    this.frozenEtas[id] = arrival;
  }

  addScenarioNotice(scenario, stopId) {
    const messages = {
      received: ['주문이 접수되었습니다', '주문 접수와 결제가 완료되었습니다.'],
      picking: ['상품을 준비하고 있습니다', '출고를 위해 상품을 피킹하고 있습니다.'],
      ready: ['출고 준비가 완료되었습니다', '배송 차량에 상차할 준비가 완료되었습니다.'],
      shipping: ['배송이 출발했습니다', '주문하신 상품이 출발했습니다.'],
      arrived: ['기사님이 도착했어요', '주문하신 상품을 전달하고 있습니다.'],
      completed: ['배송이 완료되었습니다', `${formatTime(this.simTime)} 상품 전달을 완료했습니다.`],
    };
    const [title, body] = messages[scenario];
    this.notifyStop(stopId, title, body, false, { kind: scenario });
  }

  arriveStopDirect(stopId) {
    if (this.phase !== 'delivering' || this.truck.toId !== stopId || this.truck.dwellRemaining > 0) return false;
    return this.setScenario('arrived', stopId);
  }

  completeCurrentStop(confirmedRequestIds) {
    if (this.phase !== 'delivering' || !this.truck.atStopId || this.truck.dwellRemaining <= 0) return false;
    if (!validRequestConfirmation(this.truck.atStopId, confirmedRequestIds)) return false;
    const requests = exampleRequestsFor(this.truck.atStopId);
    if (requests.items.length) this.recordDeliveryEvent(`고객 요청 이행 확인: ${requests.items.map(item => item.label).join(', ')}`, 'driver', this.truck.atStopId, { action: 'requests_confirmed' });
    return this.setScenario('completed', this.truck.atStopId);
  }

  knownDelivery(stopId) {
    if (this.stops?.[stopId]) return { stop: this.stops[stopId], vehicle: LIVE_VEHICLE };
    const stop = this.fleet?.deliveries.find(item => item.id === stopId);
    if (!stop) return null;
    return { stop, vehicle: this.fleet.vehicles.find(item => item.id === stop.vehicleId) };
  }

  recordDeliveryEvent(message, type, stopId, metadata = {}) {
    const target = this.knownDelivery(stopId);
    if (!target) return false;
    super.logEvent(message, type);
    Object.assign(this.events.at(-1), {
      stopId,
      vehicleId: target.vehicle.id,
      ...metadata,
    });
    return true;
  }

  notifyStop(stopId, title, body, log = true, extra = {}) {
    const target = this.knownDelivery(stopId);
    if (!target) return false;
    const customerWindow = this.customerPromises?.get(stopId)?.window;
    if (/배송이 출발했습니다/.test(title) && customerWindow) {
      body = `주문하신 상품이 출발했습니다. 도착 예정 시간은 ${customerWindow.text}입니다.`;
    }
    const notice = {
      id: this.nextNotificationId++,
      stopId,
      ts: this.simTime,
      time: formatTime(this.simTime),
      clock: formatTime(this.simTime),
      title,
      body,
      kind: extra.kind || (/변경|지연/.test(title) ? 'delay' : /완료/.test(title) ? 'complete' : /도착/.test(title) ? 'arrival' : /출발/.test(title) ? 'departure' : 'info'),
      channel: '고객 팝업',
      status: '시연 발송',
      target: target.stop.name,
      ...extra,
    };
    this.notifications.push(notice);
    const retained = new Map();
    for (let index = this.notifications.length - 1; index >= 0; index--) {
      const count = (retained.get(this.notifications[index].stopId) || 0) + 1;
      retained.set(this.notifications[index].stopId, count);
      if (count > MAX_NOTICES_PER_STOP) this.notifications.splice(index, 1);
    }
    if (this.notifications.length > MAX_NOTICES) this.notifications.splice(0, this.notifications.length - MAX_NOTICES);
    if (log) this.recordDeliveryEvent(`고객 팝업 기록: ${target.stop.name} — ${title}`, 'notify', stopId);
    return true;
  }

  recalcEtas(reason, { silent = false } = {}) {
    if (this.operatingResetting) return super.recalcEtas(reason, { silent: true });
    if (['기사 배송 순서 변경', '운영 배송 순서 변경', '배송 경로 변경'].includes(reason)) {
      this.scenarioPreset = null;
      this.scenarioStopId = null;
    }
    const etas = this.stopEtas();
    let notified = 0;
    for (const id of this.order) {
      const arrival = etas[id];
      if (arrival == null) continue;
      const previousExact = this.officialEtas[id];
      const deltaMin = previousExact ? Math.round((arrival - previousExact.arrival) / MIN) : 0;
      let promise = this.customerPromises.get(id);
      if (!promise) {
        promise = { arrival, window: windowFor(arrival) };
        this.customerPromises.set(id, promise);
      } else if (arrival - promise.arrival > 30 * MIN) {
        promise = { arrival, window: windowFor(arrival) };
        this.customerPromises.set(id, promise);
        this.notifyStop(id, '배송이 지연되고 있습니다', `새 도착 예정 시간은 ${promise.window.text}입니다.`, true, { kind: 'delay' });
        notified++;
      }
      this.officialEtas[id] = { arrival, time: arrival, reason, deltaMin, updatedAt: this.simTime };
    }
    if (!silent) this.logEvent(`ETA 재계산(${reason})${notified ? ` — 고객 지연 안내 ${notified}건` : ''}`, 'eta');
  }

  sendCustomerNotice(stopId, body, author) {
    if (!this.knownDelivery(stopId) || !validPlainText(body, MAX_NOTICE_LENGTH)) return false;
    this.notifyStop(stopId, '운영자 안내', normalizePlainText(body), true, { kind: 'manual', author: String(author || '운영자') });
    this.emit();
    return true;
  }

  setDeliveryTip(stopId, body) {
    const target = this.knownDelivery(stopId);
    if (!target || !validPlainText(body, MAX_TIP_LENGTH)) return false;
    this.deliveryTips.set(stopId, { body: normalizePlainText(body), author: target.vehicle.driver, updatedAt: this.simTime });
    this.recordDeliveryEvent(`배송 팁 수정: ${target.stop.name}`, 'driver', stopId);
    this.emit();
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const liveVehicle = this.fleet?.vehicles[0] || { ...LIVE_VEHICLE, planned: { stops: 8, boxes: 60 }, capacityBoxes: 60 };
    const departure = { time: formatTime(PREP.departed.at), source: 'scenario-baseline' };
    const liveStatus = this.phase === 'done' ? '배송 완료'
      : this.phase === 'delivering' ? (this.truck.dwellRemaining > 0 ? '하차 중' : '배송 중')
        : '출고 준비';
    const vehicles = this.fleet.vehicles.map(vehicle => vehicle.live ? { ...vehicle, status: liveStatus, departure } : vehicle);
    state.order = state.order.map(stop => ({
      ...stop,
      vehicleId: liveVehicle.id,
      tip: this.deliveryTips?.get(stop.id) || null,
      customerRequests: exampleRequestsFor(stop.id),
    }));
    for (const [id, customer] of Object.entries(state.customers)) {
      const promise = this.customerPromises.get(id);
      if (!promise) continue;
      const mayRestoreEta = this.stops[id]?.arrivedAt != null || this.stops[id]?.status === 'done';
      if (!customer.eta && !mayRestoreEta) continue;
      const preciseArrival = this.officialEtas[id]?.arrival ?? this.stops[id].arrivedAt ?? promise.arrival;
      customer.eta ||= { reason: '고객 안내 약속', deltaMin: 0, updatedAt: this.simTime };
      customer.eta.time = preciseArrival;
      customer.eta.preciseTimeText = formatTime(preciseArrival);
      customer.eta.windowText = promise.window.text;
      customer.eta.windowStart = promise.window.start;
      customer.eta.windowEnd = promise.window.end;
      customer.eta.timeText = promise.window.text;
    }
    state.vehicles = vehicles;
    state.customerStopId = this.scenarioStopId || state.customerStopId;
    state.scenarioPreset = this.scenarioPreset;
    state.scenarioStopId = this.scenarioStopId;
    state.fleet = {
      vehicles,
      deliveries: this.fleet.deliveries.map(stop => ({
        ...stop,
        tip: this.deliveryTips.get(stop.id) || null,
      })),
    };
    state.kpi.boxesTotal = 60;
    state.kpi.boxesDelivered = this.order.filter(id => this.stops[id].status === 'done').reduce((sum, id) => sum + this.stops[id].boxes, 0);
    state.kpi.vehicleTiming = vehicleTiming(this, state);
    return state;
  }
}

module.exports = { OperatingSimulation, validPlainText, normalizePlainText, windowFor, MAX_NOTICE_LENGTH, MAX_TIP_LENGTH, MAX_NOTICES, MAX_NOTICES_PER_STOP, SCENARIOS };
