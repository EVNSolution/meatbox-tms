import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVehicleControl } from './vehicle-control.mjs';

class FakeNode {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.dataset = {};
    this.listeners = {};
    this.open = false;
    this.scrollTop = 0;
  }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this[name] = value; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
}

globalThis.document = { activeElement: null, createElement: () => new FakeNode() };
globalThis.CSS = { escape: value => String(value) };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

function fixture() {
  const nodes = new Map();
  const element = new FakeNode();
  element.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode());
    return nodes.get(selector);
  };
  return { element, node: selector => nodes.get(selector) };
}

const vehicle = { id: 'V2', plate: '예시 차량 002', driver: '예시 배송원 002', live: false };
const deliveries = [
  { id: 'V2-S1', vehicleId: 'V2', name: '배송지 1', boxes: 2, status: 'pending' },
  { id: 'V2-S2', vehicleId: 'V2', name: '배송지 2', boxes: 2, status: 'pending' },
  { id: 'V2-S3', vehicleId: 'V2', name: '배송지 3', boxes: 2, status: 'pending' },
];
const data = { fleetVehicles: [vehicle], fleetDeliveries: deliveries, events: [] };
const mapFactory = () => ({ resize() {}, jumpTo() {}, fitBounds() {}, remove() {} });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('위치 데이터 실패는 update로 재요청하지 않고 같은 오류를 유지한다', async () => {
  const { element, node } = fixture();
  let attempts = 0;
  let rejectLoad;
  const control = mountVehicleControl({
    element,
    onSelectVehicle() {}, onSelectDelivery() {}, onOpenNotice() {},
    mapFactory,
    loadRouteData: () => {
      attempts += 1;
      return new Promise((_, reject) => { rejectLoad = reject; });
    },
  });

  control.update(data, 'V2', 'V2-S1');
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.doesNotMatch(node('[data-control-map-note]').textContent, /위치 미등록 \d+곳/);
  rejectLoad(new Error('offline'));
  await flush();
  const failure = node('[data-control-map-note]').textContent;
  assert.match(failure, /불러오지 못했습니다/);

  control.update({ ...data, simClock: '06:10' }, 'V2', 'V2-S1');
  await flush();
  assert.equal(attempts, 1);
  assert.equal(node('[data-control-map-note]').textContent, failure);
  control.destroy();
});

test('정상 위치 수신 뒤에만 미등록 수를 확정하고 잘못된 좌표는 제외한다', async () => {
  const { element, node } = fixture();
  const marked = [];
  const control = mountVehicleControl({
    element,
    onSelectVehicle() {}, onSelectDelivery() {}, onOpenNotice() {},
    mapFactory,
    markerFactory: (_map, delivery, coordinates) => {
      marked.push([delivery.id, coordinates]);
      return { element: new FakeNode(), remove() {} };
    },
    loadRouteData: () => Promise.resolve({
      points: [
        { id: 'V2-S1', lng: 127.1, lat: 37.5 },
        { id: 'V2-S2', lng: 999, lat: 37.5 },
        { id: 'V2-S3', lng: '127.2', lat: 37.6 },
      ],
    }),
  });

  control.update(data, 'V2', 'V2-S1');
  assert.doesNotMatch(node('[data-control-map-note]').textContent, /위치 미등록 \d+곳/);
  await flush();
  assert.deepEqual(marked, [['V2-S1', [127.1, 37.5]]]);
  assert.match(node('[data-control-map-note]').textContent, /남은 배송지 1곳 표시, 위치 미등록 2곳/);
  control.destroy();
});

test('배송지 펼침은 핵심 정보만 남기고 대상 기록과 안내를 배송 관리로 연결한다', () => {
  const { element, node } = fixture();
  const opened = [], notices = [], selected = [];
  const control = mountVehicleControl({ element, mapFactory, loadRouteData: () => new Promise(() => {}),
    onSelectVehicle() {}, onSelectDelivery: id => selected.push(id), onOpenManagement: id => opened.push(id), onOpenNotice: id => notices.push(id),
  });
  const next = { ...data, fleetDeliveries: deliveries.map((stop, index) => ({ ...stop, sequence: index + 1,
    notices: [{ id: `n${index}`, stopId: stop.id, time: '06:20', title: `안내 ${index}`, body: `본문 ${index}` }],
  })), events: [{ stopId: 'V2-S1', vehicleId: 'V2', time: '06:10', message: '첫 배송지 사건' }] };
  control.update(next, 'V2', 'V2-S1');
  assert.match(node('[data-control-stops]').innerHTML, /이력·알림 보기/);
  assert.doesNotMatch(node('[data-control-stops]').innerHTML, /첫 배송지 사건|본문 0|control-record-list|control-notices/);
  assert.match(node('[data-control-records]').innerHTML, /첫 배송지 사건/);
  assert.match(node('[data-control-records]').innerHTML, /본문 0/);
  assert.doesNotMatch(node('[data-control-records]').innerHTML, /본문 1/);
  const summary = node('[data-control-summary]').innerHTML;
  node('[data-control-stops]').listeners.click({ target: { closest: () => ({ dataset: { controlManage: 'V2-S1' } }) } });
  assert.deepEqual(opened, ['V2-S1']);
  assert.equal(node('[data-control-records-view]').hidden, false);
  node('[data-control-compose]').listeners.click();
  assert.deepEqual(notices, ['V2-S1']);
  node('[data-control-record-stop]').listeners.change({ target: { value: 'V2-S2' } });
  assert.deepEqual(selected, ['V2-S2']);
  control.update(next, 'V2', 'V2-S2');
  assert.equal(node('[data-control-summary]').innerHTML, summary);
  assert.match(node('[data-control-records]').innerHTML, /본문 1/);
  assert.doesNotMatch(node('[data-control-records]').innerHTML, /본문 0|첫 배송지 사건/);
  control.destroy();
});

test('기록 필터와 순서 관리 화면 전환은 편집 영역을 재생성하지 않는다', () => {
  const { element, node } = fixture();
  let editStarts = 0;
  const control = mountVehicleControl({ element, mapFactory, loadRouteData: () => new Promise(() => {}),
    onSelectVehicle() {}, onSelectDelivery() {}, onOpenNotice() {}, onOpenManagement() {}, onOpenRoute() { editStarts += 1; },
  });
  const next = { ...data, fleetDeliveries: [{ ...deliveries[0], notices: [{ id: 'n', stopId: 'V2-S1', time: '06:20', title: '대상 알림' }] }],
    events: [{ stopId: 'V2-S1', vehicleId: 'V2', time: '06:10', message: '대상 이력' }] };
  control.update(next, 'V2', 'V2-S1');
  node('.control-record-filters').listeners.click({ target: { closest: () => ({ dataset: { controlRecordFilter: 'notice' } }) } });
  assert.match(node('[data-control-records]').innerHTML, /대상 알림/);
  assert.doesNotMatch(node('[data-control-records]').innerHTML, /대상 이력/);
  assert.equal(node('[data-control-common]').hidden, true);
  const route = element.querySelector('#route-editor');
  route.innerHTML = 'existing editor with draft';
  node('[data-control-route]').listeners.click();
  assert.equal(editStarts, 1);
  assert.equal(node('[data-control-records-view]').hidden, true);
  assert.equal(node('[data-control-route-view]').hidden, false);
  control.showRecords();
  assert.equal(node('[data-control-route-view]').hidden, true);
  assert.equal(route.innerHTML, 'existing editor with draft');
  control.update({ ...next, connected: false }, 'V2', 'V2-S1');
  assert.equal(node('[data-control-compose]').disabled, true);
  control.destroy();
});
