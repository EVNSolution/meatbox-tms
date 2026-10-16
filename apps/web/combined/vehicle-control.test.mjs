import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
globalThis.maplibregl = { Marker: class {
  constructor({ element }) { this.element = element; }
  setLngLat(coordinates) { this.coordinates = coordinates; return this; }
  addTo() { return this; }
  remove() {}
} };

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

test('운영 관제는 삭제한 시나리오 API를 기본 위치 공급자로 사용하지 않는다', () => {
  const source = readFileSync(new URL('./vehicle-control.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/scenario\/api/);
  assert.match(source, /loadRouteData = null/);
});

test('자료가 없거나 확인 중이어도 관제 카드와 운행 정보 구조를 유지한다', () => {
  const { element, node } = fixture();
  let mapCreates = 0;
  const control = mountVehicleControl({
    element,
    onSelectVehicle() {}, onSelectDelivery() {},
    mapFactory() { mapCreates += 1; return mapFactory(); },
  });

  assert.equal(control.update(null), null);
  assert.equal(node('[data-control-count]').textContent, '미확인');
  assert.match(node('[data-control-summary]').innerHTML, /남은 배송지<\/span><strong>미확인/);
  assert.equal([...node('[data-control-summary]').innerHTML.matchAll(/<div><span>/g)].length, 3);
  assert.equal([...node('[data-control-summary]').innerHTML.matchAll(/<div><dt>/g)].length, 6);
  assert.equal(node('[data-control-search]').disabled, true);
  assert.match(node('[data-control-record-stop]').innerHTML, /배송 자료 미확인/);
  assert.match(node('[data-control-records]').innerHTML, /미확인/);
  assert.match(node('[data-control-events]').innerHTML, /미확인/);
  assert.doesNotMatch(node('[data-control-records]').innerHTML, /기록이 없습니다/);
  assert.equal(mapCreates, 1, '자료가 없어도 빈 지도를 보여 준다');

  node('[data-support-data]').innerHTML = '<table><tr><td>이전 지원배차</td></tr></table>';
  control.clear({ message: '배송 자료를 불러오지 못했습니다.' });
  assert.match(node('[data-control-map-note]').textContent, /배송 자료를 불러오지 못했습니다/);
  assert.match(node('[data-control-summary]').innerHTML, /남은 박스<\/span><strong>미확인/);
  assert.match(node('[data-control-summary]').innerHTML, /배송 자료를 불러오지 못했습니다/);
  assert.match(node('[data-control-records]').innerHTML, /미확인/);
  assert.match(node('[data-control-events]').innerHTML, /미확인/);
  assert.equal(node('[data-support-data]').innerHTML, '');

  assert.equal(control.update({ fleetVehicles: [], fleetDeliveries: [], events: [] }), null);
  assert.equal(node('[data-control-count]').textContent, '0대');
  assert.match(node('[data-control-summary]').innerHTML, /남은 배송지<\/span><strong>0곳/);
  assert.match(node('[data-control-summary]').innerHTML, /남은 박스<\/span><strong>0박스/);
  assert.match(node('[data-control-summary]').innerHTML, /보류 배송지<\/dt><dd>0곳/);
  assert.match(node('[data-control-summary]').innerHTML, /현재 도착 ETA<\/dt><dd>미확인/);
  assert.match(node('[data-control-record-stop]').innerHTML, /배정된 배송지 없음/);
  assert.match(node('[data-control-records]').innerHTML, /미등록/);
  assert.match(node('[data-control-events]').innerHTML, /미등록/);
  assert.match(node('[data-control-vehicles]').innerHTML, /미배정/);
  assert.equal(node('[data-control-map]').innerHTML, '');
  assert.doesNotMatch(node('[data-control-summary]').innerHTML + node('[data-control-stops]').innerHTML + node('[data-control-records]').innerHTML, /empty-state|없습니다/);
  assert.match(node('[data-control-map-note]').textContent, /확정된 배차가 없습니다/);
  assert.equal(mapCreates, 1, '같은 지도를 다시 만들지 않는다');
  control.destroy();
});

test('운영 자료가 사라졌다가 돌아오면 초기화한 관제 기능과 지도를 복구한다', () => {
  const { element, node } = fixture();
  let mapCreates = 0;
  let mapRemoves = 0;
  const control = mountVehicleControl({
    element,
    onSelectVehicle() {}, onSelectDelivery() {},
    mapFactory() {
      mapCreates += 1;
      return { resize() {}, jumpTo() {}, fitBounds() {}, remove() { mapRemoves += 1; } };
    },
  });

  control.update(data, 'V2', 'V2-S1');
  assert.equal(mapCreates, 1);
  assert.equal(node('[data-control-search]').disabled, false);
  node('[data-control-search]').listeners.input({ target: { value: '없는 차량' } });
  assert.match(node('[data-control-vehicles]').innerHTML, /검색 결과 없음/);

  control.clear({ empty: true, message: '확정된 배차가 없습니다.' });
  assert.equal(mapRemoves, 0, '작업이 없어도 지도는 유지한다');
  assert.equal(node('[data-control-search]').value, '');
  assert.equal(node('[data-control-sort]').value, 'received');
  assert.equal(node('[data-control-records-view]').hidden, false);
  assert.equal(node('[data-control-route-view]').hidden, true);
  assert.doesNotThrow(() => node('.control-record-filters').listeners.click({ target: { closest: () => ({ dataset: { controlRecordFilter: 'notice' } }) } }));

  control.update(data, 'V2', 'V2-S1');
  assert.equal(mapCreates, 1);
  assert.equal(node('[data-control-search]').disabled, false);
  assert.equal(node('[data-control-sort]').disabled, false);
  assert.equal(node('[data-control-support]').disabled, false);
  assert.equal(node('[data-control-route]').disabled, false);
  assert.match(node('[data-control-vehicles]').innerHTML, /예시 차량 002/);
  assert.doesNotMatch(node('[data-control-map]').innerHTML, /확정된 배차가 없습니다/);
  control.destroy();
});

test('빈 상태로 바뀌면 열린 지원배차를 닫고 비활성 동작을 무시한다', () => {
  const { element, node } = fixture();
  const control = mountVehicleControl({
    element, mapFactory,
    onSelectVehicle() {}, onSelectDelivery() {},
  });
  control.update(data, 'V2', 'V2-S1');
  node('[data-control-support]').listeners.click();
  assert.equal(node('[data-support-dialog]').open, true);

  control.clear({ empty: true, message: '확정된 배차가 없습니다.' });
  assert.equal(node('[data-support-dialog]').open, false);
  node('[data-control-support]').listeners.click();
  assert.equal(node('[data-support-dialog]').open, false);
  assert.doesNotMatch(element.innerHTML, /data-control-compose|notice-send-status/);
  control.destroy();
});

test('이전 위치 응답은 clear 이후 빈 지도 안내를 덮지 않는다', async () => {
  const { element, node } = fixture();
  let resolveFirst;
  let loads = 0;
  let markers = 0;
  const control = mountVehicleControl({
    element, mapFactory,
    onSelectVehicle() {}, onSelectDelivery() {},
    markerFactory() { markers += 1; return { element: new FakeNode(), remove() {} }; },
    loadRouteData() {
      loads += 1;
      if (loads === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve({ points: [] });
    },
  });

  control.update(data, 'V2', 'V2-S1');
  await Promise.resolve();
  control.clear({ empty: true, message: '확정된 배차가 없습니다.' });
  resolveFirst({ points: [{ id: 'V2-S1', lng: 127.1, lat: 37.5 }] });
  await flush();
  assert.equal(markers, 0);
  assert.equal(node('[data-control-map]').innerHTML, '');
  assert.equal(node('[data-control-map-note]').textContent, '확정된 배차가 없습니다.');

  control.update(data, 'V2', 'V2-S1');
  await flush();
  assert.equal(loads, 2);
  assert.doesNotMatch(node('[data-control-map]').innerHTML, /확정된 배차가 없습니다/);
  control.destroy();
});

test('destroy 이후 도착한 위치 응답은 제거한 지도를 다시 그리지 않는다', async () => {
  const { element, node } = fixture();
  let resolveLoad;
  let markers = 0;
  const control = mountVehicleControl({
    element, mapFactory,
    onSelectVehicle() {}, onSelectDelivery() {},
    markerFactory() { markers += 1; return { element: new FakeNode(), remove() {} }; },
    loadRouteData: () => new Promise(resolve => { resolveLoad = resolve; }),
  });

  control.update(data, 'V2', 'V2-S1');
  await Promise.resolve();
  const note = node('[data-control-map-note]').textContent;
  control.destroy();
  resolveLoad({ points: [{ id: 'V2-S1', lng: 127.1, lat: 37.5 }] });
  await flush();
  assert.equal(markers, 0);
  assert.equal(node('[data-control-map-note]').textContent, note);
});

test('위치 데이터 실패는 update로 재요청하지 않고 같은 오류를 유지한다', async () => {
  const { element, node } = fixture();
  let attempts = 0;
  let rejectLoad;
  const control = mountVehicleControl({
    element,
    onSelectVehicle() {}, onSelectDelivery() {},
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
    onSelectVehicle() {}, onSelectDelivery() {},
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

test('운영 주문 좌표를 직접 쓰고 기본 차량을 선택하며 GPS 미수신을 구분한다', () => {
  const { element, node } = fixture();
  let routeLoads = 0;
  const marked = [];
  const source = {
    sourceData: { date: '2026-09-16', defaultVehicleId: 'real-b', defaultStopId: 'real-b-1' },
    fleetVehicles: [
      { id: 'real-a', plate: '11가 1111', driver: '실제기사A', live: true, location: { coordinates: [127, 37.5], label: '서울 예시 위치', source: 'demo' } },
      { id: 'real-b', plate: '22나 2222', driver: '실제기사B', live: true, location: { coordinates: [127.1, 37.6], label: '경기 예시 위치', source: 'demo' } },
    ],
    fleetDeliveries: [
      { id: 'real-a-1', vehicleId: 'real-a', name: '실제 주문 A', boxes: 3, status: 'done', coordinates: [126.9, 37.4] },
      { id: 'real-b-1', vehicleId: 'real-b', name: '실제 주문 B', boxes: 7, status: 'current', coordinates: [127.2, 37.7] },
      { id: 'real-b-2', vehicleId: 'real-b', name: '좌표 없음', boxes: 2, status: 'pending', coordinates: null },
    ],
    events: [],
  };
  const control = mountVehicleControl({
    element, mapFactory,
    loadRouteData() { routeLoads += 1; return Promise.reject(new Error('must not load')); },
    markerFactory: (_map, delivery, coordinates) => {
      marked.push([delivery.id, coordinates]);
      return { element: new FakeNode(), remove() {} };
    },
    onSelectVehicle() {}, onSelectDelivery() {},
  });
  const selected = control.update(source, null, null);
  assert.equal(selected.vehicle.id, 'real-b');
  assert.equal(routeLoads, 0);
  assert.deepEqual(marked, [['real-b-1', [127.2, 37.7]]]);
  assert.match(node('[data-control-summary]').innerHTML, /실제기사B/);
  assert.match(node('[data-control-summary]').innerHTML, /운영 현황/);
  assert.match(node('[data-control-summary]').innerHTML, /2026-09-16 승인 운영 계획 추정치/);
  assert.doesNotMatch(node('[data-control-summary]').innerHTML, /원본|로컬|시연|데모|예시/);
  assert.match(node('[data-control-map-note]').textContent, /남은 배송지 1곳 표시, 위치 미등록 1곳/);
  assert.match(node('[data-control-map-note]').textContent, /차량 기준 위치 표시.*실시간 GPS 미수신/);
  assert.doesNotMatch(node('[data-control-map-note]').textContent, /원본|로컬|시연|데모|예시/);
  node('[data-control-support]').listeners.click();
  assert.match(node('[data-support-data]').innerHTML, /차량 운영 현황/);
  assert.match(node('[data-support-data]').innerHTML, /승인 운영 계획/);
  assert.match(node('[data-support-data]').innerHTML, /GPS 기반 주변 차량 비교는 산정 대기/);
  assert.match(node('[data-support-data]').innerHTML, /계획 출발/);
  assert.match(node('[data-support-data]').innerHTML, /06:30/);
  assert.match(node('[data-support-data]').innerHTML, /기준 미정/);
  assert.doesNotMatch(node('[data-support-data]').innerHTML, /원본|로컬|시연|데모|예시/);
  control.destroy();
});

test('지원배차는 승인 계획과 수신된 실제 처리 구간을 보여주되 등급과 외부 연결을 만들지 않는다', () => {
  const { element, node } = fixture();
  const source = {
    sourceData: { date: '2026-09-16', defaultVehicleId: 'V1' },
    fleetVehicles: [{ id: 'V1', plate: '11가 1111', driver: '배송원' }],
    fleetDeliveries: [
      { id: 'O1', vehicleId: 'V1', name: '완료점', address: '서울', coordinates: [127, 37.5], status: 'done', boxes: 2, completedAt: '07:59' },
      { id: 'O2', vehicleId: 'V1', name: '다음점', address: '경기', coordinates: [127, 37.5], status: 'pending', boxes: 3 },
    ],
    events: [{ action: 'shipping', vehicleId: 'V1', time: '07:58' }],
  };
  const control = mountVehicleControl({
    element, mapFactory, loadRouteData: () => Promise.reject(new Error('must not load')),
    onSelectVehicle() {}, onSelectDelivery() {},
  });
  control.update(source, null, null);
  assert.match(node('[data-control-summary]').innerHTML, /고정 출발 기준<\/dt><dd>06:30/);
  assert.match(node('[data-control-summary]').innerHTML, /마지막 도착 ETA<\/dt><dd>07:59/);
  assert.match(node('[data-control-summary]').innerHTML, /전체 인도 완료<\/dt><dd>08:03/);
  node('[data-control-support]').listeners.click();
  const support = node('[data-support-data]').innerHTML;
  assert.match(support, /승인 운영계획/);
  assert.match(support, /1곳 \/ 1분/);
  assert.match(support, /기준 미정/);
  assert.doesNotMatch(support, /실시간 GPS 수신|외부 전송 완료|호출 완료|수락 완료/);
  control.destroy();
});

test('배송지 펼침은 핵심 정보만 남기고 대상 기록과 안내를 배송 관리로 연결한다', () => {
  const { element, node } = fixture();
  const opened = [], selected = [];
  const control = mountVehicleControl({ element, mapFactory, loadRouteData: () => new Promise(() => {}),
    onSelectVehicle() {}, onSelectDelivery: id => selected.push(id), onOpenManagement: id => opened.push(id),
  });
  const next = { ...data, fleetDeliveries: deliveries.map((stop, index) => ({ ...stop, sequence: index + 1,
    notices: [{ id: `n${index}`, stopId: stop.id, time: '06:20', title: `안내 ${index}`, body: `본문 ${index}` }],
  })), events: [{ stopId: 'V2-S1', vehicleId: 'V2', time: '06:10', message: '첫 배송지 사건' }] };
  control.update(next, 'V2', 'V2-S1');
  assert.match(node('[data-control-stops]').innerHTML, /기록 보기/);
  assert.doesNotMatch(node('[data-control-stops]').innerHTML, /첫 배송지 사건|본문 0|control-record-list|control-notices/);
  assert.match(node('[data-control-records]').innerHTML, /첫 배송지 사건/);
  assert.match(node('[data-control-records]').innerHTML, /본문 0/);
  assert.doesNotMatch(node('[data-control-records]').innerHTML, /본문 1/);
  const summary = node('[data-control-summary]').innerHTML;
  node('[data-control-stops]').listeners.click({ target: { closest: () => ({ dataset: { controlManage: 'V2-S1' } }) } });
  assert.deepEqual(opened, ['V2-S1']);
  assert.equal(node('[data-control-records-view]').hidden, false);
  assert.doesNotMatch(element.innerHTML, /data-control-compose|notice-send-status/);
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
    onSelectVehicle() {}, onSelectDelivery() {}, onOpenManagement() {}, onOpenRoute() { editStarts += 1; },
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
  control.destroy();
});

const sensorState = (extra = {}) => ({ temperature: { celsius: -18.4, measuredAt: '2026-11-02T09:12:30+09:00', stale: false, outOfRange: false, ...extra } });

test('관제 차량 행·운행 요약·지도 마커가 서버가 준 온도와 상태를 문구로 보여 준다', () => {
  const { element, node } = fixture();
  const control = mountVehicleControl({ element, onSelectVehicle() {}, onSelectDelivery() {}, mapFactory });
  const hot = { ...vehicle, location: { coordinates: [127, 37.5], label: '서울 예시 위치', source: 'demo' } };
  const cold = { id: 'V3', plate: '예시 차량 003', driver: '예시 배송원 003', live: false };
  const quiet = { id: 'V4', plate: '예시 차량 004', driver: '예시 배송원 004', live: false };
  const stops = [...deliveries, { id: 'V3-S1', vehicleId: 'V3', name: '배송지 4', boxes: 1, status: 'pending' }, { id: 'V4-S1', vehicleId: 'V4', name: '배송지 5', boxes: 1, status: 'pending' }];
  const withTemperature = {
    fleetVehicles: [hot, cold, quiet], fleetDeliveries: stops, events: [],
    vehicleStates: { V2: sensorState({ celsius: -12, outOfRange: true }), V3: sensorState(), V4: {} },
  };
  control.update(withTemperature, 'V2', 'V2-S1');
  const list = node('[data-control-vehicles]').innerHTML;
  assert.match(list, /<span class="badge red">범위 밖<\/span> -12\.0°C/);
  assert.match(list, /<span class="badge green">정상<\/span> -18\.4°C/);
  assert.equal([...list.matchAll(/control-temp/g)].length, 2, '값을 보내지 않은 차량 행에는 온도 줄이 없다');
  assert.match(node('[data-control-summary]').innerHTML, /data-temp-kind="out">온도 -12\.0°C 범위 밖<\/span>/);

  node('[data-control-sort]').listeners.change({ target: { value: 'temperature' } });
  const sorted = node('[data-control-vehicles]').innerHTML;
  assert.ok(sorted.indexOf('V2') < sorted.indexOf('V3') && sorted.indexOf('V3') < sorted.indexOf('V4'), '범위 밖, 정상, 정보 없음 순');

  control.update({ ...withTemperature, vehicleStates: { V2: sensorState({ stale: true }) } }, 'V2', 'V2-S1');
  assert.match(node('[data-control-summary]').innerHTML, /온도 -18\.4°C 미수신, 마지막 수신 09:12/);
  control.update({ ...withTemperature, vehicleStates: {} }, 'V2', 'V2-S1');
  assert.doesNotMatch(node('[data-control-summary]').innerHTML, /온도 /);
  control.destroy();
});

test('온도 현황 버튼은 자료가 없으면 꺼지고 차량이 있으면 켜진다', () => {
  const { element, node } = fixture();
  const control = mountVehicleControl({ element, onSelectVehicle() {}, onSelectDelivery() {}, mapFactory });
  control.update(null);
  assert.equal(node('[data-control-temperature]').disabled, true);
  control.update(data, 'V2', 'V2-S1');
  assert.equal(node('[data-control-temperature]').disabled, false);
  control.destroy();
});

test('온도 현황에서 고른 차량은 온도 탭으로 열린다', () => {
  const { element } = fixture();
  const opened = [];
  const selected = [];
  mountVehicleControl({ element, onSelectVehicle: id => selected.push(id), onOpenTemperature: id => opened.push(id), onSelectDelivery() {}, mapFactory })
    .destroy();
  const source = readFileSync(new URL('./vehicle-control.mjs', import.meta.url), 'utf8');
  assert.match(source, /data-control-tab="temperature"/);
  assert.match(source, /onSelectVehicle: id => onOpenTemperature\(id\)/);
  assert.deepEqual([opened, selected], [[], []]);
});

test('기사가 출발하면 서버가 계산한 ETA를 배송지와 운행 상세에 보이고 출발 전에는 계획 추정치임을 알린다', () => {
  const { element, node } = fixture();
  const control = mountVehicleControl({ element, onSelectVehicle() {}, onSelectDelivery() {}, mapFactory });
  const planned = deliveries.map(stop => ({ ...stop, calculatedEta: '09:00', status: stop.id === 'V2-S1' ? 'current' : 'pending' }));
  const before = { fleetVehicles: [vehicle], fleetDeliveries: planned, events: [], sourceData: { date: '2026-11-02' } };
  control.update(before, 'V2', 'V2-S1');
  assert.match(node('[data-control-stops]').innerHTML, /<dt>도착 ETA<\/dt><dd>09:00<\/dd>/);
  assert.match(node('[data-control-summary]').innerHTML, /기사 앱에서 출발하면 서버가 계산한 ETA가 표시됩니다\. 지금 ETA는 계획 추정치입니다\./);

  const eta = { computedAt: '2026-11-02T09:12:10+09:00', reason: 'reordered', departedAt: '2026-11-02T09:12:03+09:00', departureTimeSource: 'device', recomputes: 1,
    stops: [{ stopId: 'V2-S1', sequence: 1, eta: '2026-11-02T09:40:00+09:00', estimated: true }, { stopId: 'V2-S2', sequence: 2, eta: '2026-11-02T09:58:00+09:00', estimated: false }] };
  control.update({ ...before, vehicleStates: { V2: { eta } } }, 'V2', 'V2-S1');
  assert.match(node('[data-control-stops]').innerHTML, /<dt>도착 ETA<\/dt><dd>09:40 \(서버 계산\)<\/dd>/);
  assert.match(node('[data-control-summary]').innerHTML, /현재 도착 ETA<\/dt><dd>09:40 \(서버 계산\)/);
  assert.match(node('[data-control-summary]').innerHTML, /서버 ETA: 출발 09:12\(기기 시각\), 산출 09:12, 재산출 1회, 사유 순서 변경\./);
  assert.doesNotMatch(node('[data-control-summary]').innerHTML, /기사 앱에서 출발하면/);
  control.destroy();
});
