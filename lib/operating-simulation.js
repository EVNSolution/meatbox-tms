'use strict';

const { Simulation: OriginalSimulation } = require('../workspaces/sanghyun-scenario/src/simulation');
const { LIVE_BOXES, makeFleetData } = require('./fleet-data');

const MIN = 60 * 1000;
const MAX_NOTICE_LENGTH = 300;
const MAX_TIP_LENGTH = 500;
const LIVE_VEHICLE = { id: 'V1', plate: '서울87바 1234', driver: '김민수', region: '송파·강남 4권역', live: true };

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
    this.notifications = [];
    this.events = [];
    this.officialEtas = {};
    this.operatingResetting = false;
    this.recalcEtas('초기 안내', { silent: true });
    this.logEvent('주문 접수 완료 — 출고 준비 시작 · V1 60박스 / 8개 배송지', 'system');
    this.emit();
  }

  emit() {
    if (!this.operatingResetting) super.emit();
  }

  placeOrder() {
    if (this.phase === 'idle') return this.emit();
    return super.placeOrder();
  }

  timelineFor(id) {
    const orderedTime = formatTime(this.orderedAt ?? this.simTime);
    return super.timelineFor(id).map(item => ['주문 접수', '결제 완료'].includes(item.label)
      ? { ...item, time: orderedTime }
      : item);
  }

  knownDelivery(stopId) {
    if (this.stops?.[stopId]) return { stop: this.stops[stopId], vehicle: LIVE_VEHICLE };
    const stop = this.fleet?.deliveries.find(item => item.id === stopId);
    if (!stop) return null;
    return { stop, vehicle: this.fleet.vehicles.find(item => item.id === stop.vehicleId) };
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
    if (log) this.logEvent(`고객 팝업 기록: ${target.stop.name} — ${title}`, 'notify');
    return true;
  }

  recalcEtas(reason, { silent = false } = {}) {
    if (this.operatingResetting) return super.recalcEtas(reason, { silent: true });
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
    this.logEvent(`배송 팁 수정: ${target.stop.name}`, 'driver');
    this.emit();
    return true;
  }

  snapshot() {
    const state = super.snapshot();
    const liveVehicle = this.fleet?.vehicles[0] || { ...LIVE_VEHICLE, planned: { stops: 8, boxes: 60 }, capacityBoxes: 60 };
    const liveStatus = this.phase === 'done' ? '배송 완료'
      : this.phase === 'delivering' ? (this.truck.dwellRemaining > 0 ? '하차 중' : '배송 중')
        : '출고 준비';
    const vehicles = this.fleet.vehicles.map(vehicle => vehicle.live ? { ...vehicle, status: liveStatus } : vehicle);
    state.order = state.order.map(stop => ({
      ...stop,
      vehicleId: liveVehicle.id,
      tip: this.deliveryTips?.get(stop.id) || null,
    }));
    for (const [id, customer] of Object.entries(state.customers)) {
      if (!customer.eta) continue;
      const promise = this.customerPromises.get(id);
      customer.eta.preciseTimeText = formatTime(this.officialEtas[id].arrival);
      customer.eta.windowText = promise.window.text;
      customer.eta.windowStart = promise.window.start;
      customer.eta.windowEnd = promise.window.end;
      customer.eta.timeText = promise.window.text;
    }
    state.vehicles = vehicles;
    state.fleet = {
      vehicles,
      deliveries: this.fleet.deliveries.map(stop => ({
        ...stop,
        tip: this.deliveryTips.get(stop.id) || null,
      })),
    };
    state.kpi.boxesTotal = 60;
    state.kpi.boxesDelivered = this.order.filter(id => this.stops[id].status === 'done').reduce((sum, id) => sum + this.stops[id].boxes, 0);
    return state;
  }
}

module.exports = { OperatingSimulation, validPlainText, normalizePlainText, windowFor, MAX_NOTICE_LENGTH, MAX_TIP_LENGTH };
