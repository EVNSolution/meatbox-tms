import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totalBoxes, orderMapModel, regionOrderCounts, mountOrderPlanning } from './order-planning.mjs';

class FakeNode {
  constructor() { this.innerHTML = ''; this.value = ''; this.textContent = ''; this.listeners = {}; this.dataset = {}; this.open = false; this.focused = false; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  matches() { return false; }
}

function fixture() {
  const names = [
    'vehicle', 'map-canvas', 'map-layer', 'map-status', 'map-status-text', 'map-retry', 'map-count', 'selection', 'map-summary',
    'dispatch-actions',
    'dispatch-all', 'dispatch-pin', 'dispatch-context', 'dispatch-result', 'region-note', 'group-heading', 'group-note', 'map-description',
    'map-mode-control', 'list-panel', 'reassign-dialog', 'reassign-title',
    'reassign-close', 'reassign-from', 'reassign-target', 'reassign-preview', 'reassign-error', 'reassign-cancel', 'reassign-confirm',
    'search', 'list', 'list-total', 'page', 'previous', 'next',
  ];
  const nodes = Object.fromEntries(names.map(name => [name, new FakeNode()]));
  nodes['dispatch-actions'].hidden = true;
  nodes['dispatch-result'].hidden = true;
  nodes['reassign-error'].hidden = true;
  nodes['list-panel'].hidden = true;
  nodes['map-mode-control'].hidden = true;
  const element = new FakeNode();
  element.querySelector = selector => nodes[selector.match(/data-order-([^\]]+)/)?.[1]];
  return { element, nodes };
}

const mount = ({ element }, options = {}) => mountOrderPlanning({
  element,
  loadRouteData: () => ({ points: [] }),
  mapFactory: () => ({ resize() {}, jumpTo() {}, fitBounds() {}, remove() {} }),
  markerFactory: (_map, delivery) => ({ element: { dataset: { orderMarker: delivery.id }, setAttribute() {} }, remove() {} }),
  ...options,
});

const vehicles = [{ id: 'V1', plate: '예시 차량 1' }, { id: 'V2', plate: '예시 차량 2' }];
const deliveries = [
  { id: 'S1', vehicleId: 'V1', name: '주문 1', boxes: 8 },
  { id: 'S2', vehicleId: 'V1', name: '주문 2', boxes: 12 },
  { id: 'V2-S1', vehicleId: 'V2', name: '주문 3', boxes: 20 },
];
const data = { vehicle: vehicles[0], fleetVehicles: vehicles, fleetDeliveries: deliveries };

test('빈 배차 영역은 가짜 주문이나 지도를 만들지 않고 컨테이너와 비활성 조작을 유지한다', () => {
  const { element, nodes } = fixture();
  let maps = 0;
  const planning = mount({ element }, { mapFactory: () => { maps++; throw new Error('빈 화면에서 지도 생성 금지'); } });
  planning.clear({ empty: true, message: '등록된 주문이 없습니다.' });
  assert.equal(maps, 0);
  assert.equal(element.dataset.sourceKind, 'unavailable');
  assert.equal(nodes['group-heading'].textContent, '후보 배송원');
  assert.equal(nodes['map-summary'].textContent, '주문 0건 · 총 0박스');
  assert.equal(nodes['map-status-text'].textContent, '');
  assert.equal(nodes['map-status'].hidden, true);
  assert.match(nodes.vehicle.innerHTML, />미등록</);
  assert.doesNotMatch(nodes.vehicle.innerHTML + nodes.list.innerHTML, /등록된 주문이 없습니다/);
  assert.equal(nodes['list-panel'].hidden, false);
  assert.equal(nodes['list-panel'].open, true);
  for (const name of ['dispatch-pin', 'search', 'previous', 'next']) assert.equal(nodes[name].disabled, true);
  assert.equal(nodes['dispatch-actions'].hidden, false);
  assert.equal(nodes['map-mode-control'].hidden, false);
  planning.clear({ message: '주문 자료를 불러오지 못했습니다.' });
  assert.equal(nodes['map-status'].hidden, false);
  assert.equal(nodes['map-status-text'].textContent, '주문 자료를 불러오지 못했습니다.');
  assert.equal(nodes['map-summary'].textContent, '주문 수량 확인 전');
  assert.equal(nodes['list-total'].textContent, '확인 전');
  planning.destroy();
});

test('자료 날짜에서 빈 날짜로 이동하면 지도와 이전 주문을 제거하고 재조회 때 복원한다', () => {
  const { element, nodes } = fixture();
  let maps = 0, removed = 0, layersRemoved = 0;
  const planning = mount({ element }, {
    mapFactory: () => { maps++; return { resize() {}, fitBounds() {}, remove() { removed++; } }; },
    layerFactory: () => ({ update() {}, destroy() { layersRemoved++; } }),
  });
  planning.update(importedPlanningData());
  assert.match(nodes.vehicle.innerHTML, /기사 1/);
  assert.equal(nodes.selection.hidden, true);
  planning.clear({ empty: true, message: '등록된 주문이 없습니다.' });
  assert.equal(nodes.selection.hidden, true);
  assert.equal(nodes.selection.innerHTML, '');
  assert.equal(removed, 1);
  assert.equal(layersRemoved, 1);
  assert.doesNotMatch(nodes.vehicle.innerHTML, /기사 1/);
  assert.doesNotMatch(nodes.list.innerHTML, /1001/);
  assert.equal(nodes['map-canvas'].dataset.orderDate, undefined);
  assert.equal(nodes['dispatch-pin'].disabled, true);
  planning.update(importedPlanningData('2025-09-16'));
  assert.equal(maps, 2);
  assert.equal(nodes['map-canvas'].dataset.orderDate, '2025-09-16');
  assert.equal(nodes.search.disabled, false);
  assert.equal(nodes['list-panel'].open, false);
  assert.match(nodes.list.innerHTML, /1001/);
  planning.destroy();
});

test('주문 위치가 미등록이어도 지도 중앙에 별도 없음 카드를 만들지 않는다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element }, { layerFactory: () => ({ update() {}, destroy() {} }) });
  const input = importedPlanningData();
  input.fleetDeliveries = input.fleetDeliveries.map(order => ({ ...order, coordinates: null }));
  planning.update(input);
  assert.equal(nodes['map-status'].hidden, true);
  assert.equal(nodes['map-status-text'].textContent, '');
  assert.match(nodes['map-count'].textContent, /위치 미등록 3건/);
  assert.match(nodes.list.innerHTML, /1001/);
  planning.destroy();
});
const selectVehicle = (nodes, id) => nodes.vehicle.listeners.click({ target: { closest: () => ({ dataset: { orderVehicleId: id } }) } });
function importedPlanningData(date = '2025-09-15') {
  const sourceGroups = [{ id: 'G1', label: '기사 1' }, { id: 'G2', label: '기사 2' }];
  const sourceOrders = [
    { id: 'O1', groupId: 'G1', orderNumber: '1001', name: '주문 1', address: '서울 1', regionName: '서울', boxes: 3, coordinates: [127.1, 37.5], zoneIds: ['Z1'] },
    { id: 'O2', groupId: 'G1', orderNumber: '1002', name: '주문 2', address: '서울 2', regionName: '서울', boxes: 7, coordinates: [127.2, 37.6], zoneIds: ['Z1'] },
    { id: 'O3', groupId: 'G2', orderNumber: '1003', name: '주문 3', address: '서울 3', regionName: '서울', boxes: 11, coordinates: [127.3, 37.7], zoneIds: ['Z1'] },
  ];
  return {
    dispatchSource: { schemaVersion: 1, date, summary: { orders: 3, boxes: 21 }, groups: sourceGroups, orders: sourceOrders },
    dispatchRegions: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { zoneId: 'Z1', label: '서울 권역', quality: 'OK', baseDate: '20250630' } }] },
    fleetVehicles: [
      { id: 'G1', driver: '기사 1', plate: '11가 1001', region: '서울', source: 'demo-vehicle', location: { label: '서울 강서 예시 위치', coordinates: [126.85, 37.55], source: 'demo' } },
      { id: 'G2', driver: '기사 2', plate: '22나 2002', region: '서울', source: 'demo-vehicle', location: { label: '서울 송파 예시 위치', coordinates: [127.1, 37.51], source: 'demo' } },
    ],
    fleetDeliveries: sourceOrders.map(item => ({ ...item, originalGroupId: item.groupId, currentGroupId: item.groupId, vehicleId: item.groupId, driver: sourceGroups.find(group => group.id === item.groupId).label })),
  };
}

test('실제 주문 박스 수만 합산한다', () => {
  assert.equal(totalBoxes(deliveries), 40);
  assert.equal(totalBoxes([{ boxes: 12345 }]), 12345);
});

test('확인된 0과 빈 목록은 0이며 누락되거나 잘못된 수량을 0으로 만들지 않는다', () => {
  assert.equal(totalBoxes([]), 0);
  assert.equal(totalBoxes([{ boxes: 0 }]), 0);
  for (const source of [undefined, null, [{ boxes: null }], [{}], [{ boxes: -1 }], [{ boxes: Infinity }], [{ boxes: '8' }], [{ boxes: 8 }, {}]]) {
    assert.equal(totalBoxes(source), null);
  }
});

test('등록 좌표만 지도에 표시하고 여덟 곳을 넘겨도 자르지 않는다', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `S${index + 1}`, name: `주문 ${index + 1}` }));
  const points = many.slice(0, 10).map((delivery, index) => ({ id: delivery.id, lng: 127 + index / 100, lat: 37.5 + index / 100 }));
  points.push({ id: 'S11', lng: 999, lat: 37.5 }, { id: 'S12', lng: 127, lat: Number.NaN });
  const model = orderMapModel(many, { points });
  assert.equal(model.mapped.length, 10);
  assert.equal(model.unknownCount, 2);
  assert.deepEqual(model.mapped[9].coordinates, [127.09, 37.59]);
  assert.deepEqual(orderMapModel(many, null), { mapped: [], unknownCount: 12 });
  const withRoad = orderMapModel([many[0]], {
    points: [points[0]],
    legs: { 'MFC>S1': { coords: [[37.4, 127], [37.45, 127.01], [37.5, 127.02], [37.55, 127.03], [37.6, 127.04]] } },
  });
  assert.deepEqual(withRoad, { mapped: [{ delivery: many[0], coordinates: [127, 37.5] }], unknownCount: 0 });
});

test('권역 수량은 해당 날짜 주문의 권역 소속으로 세고 원본 경계를 바꾸지 않는다', () => {
  const regions = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { zoneId: 'Z1', label: '첫 권역' }, geometry: { type: 'Polygon', coordinates: [] } },
    { type: 'Feature', properties: { zoneId: 'Z2', label: '둘째 권역' }, geometry: { type: 'Polygon', coordinates: [] } },
    { type: 'Feature', properties: { zoneId: 'Z3', label: '빈 권역' }, geometry: { type: 'Polygon', coordinates: [] } },
  ] };
  const orders = [{ zoneIds: ['Z1', 'Z1', 'Z2'] }, { zoneIds: ['Z1'] }, { zoneIds: [] }];
  const before = structuredClone(regions);
  const result = regionOrderCounts(regions, orders);
  assert.deepEqual(result.features.map(feature => feature.properties.orderCount), [2, 1, 0]);
  assert.deepEqual(regions, before);
  assert.equal(regionOrderCounts(null, orders), null);
});

test('주문 화면이 열릴 때만 지도를 만들고 등록된 모든 좌표에 마커를 둔다', async () => {
  const { element, nodes } = fixture();
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `S${index + 1}`, vehicleId: 'V1', name: `주문 ${index + 1}`, boxes: 2 }));
  const points = many.map((delivery, index) => ({ id: delivery.id, lng: 127 + index / 100, lat: 37.5 + index / 100 }));
  let maps = 0;
  const marked = [];
  const planning = mount({ element }, {
    loadRouteData: () => ({ points }),
    mapFactory: () => { maps += 1; return { resize() {}, jumpTo() {}, fitBounds() {}, remove() {} }; },
    markerFactory: (_map, delivery, coordinates) => {
      marked.push([delivery.id, coordinates]);
      return { element: { dataset: { orderMarker: delivery.id }, setAttribute() {} }, remove() {} };
    },
  });
  assert.equal(maps, 0);
  planning.update({ vehicle: vehicles[0], fleetVehicles: [vehicles[0]], fleetDeliveries: many }, 'S10');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maps, 1);
  assert.equal(marked.length, 10);
  assert.equal(nodes['map-count'].textContent, '지도 10곳 / 전체 위치 미등록 0곳 / 선택 차량 미등록 0곳');
  assert.match(nodes.selection.innerHTML, /주문 10/);
  planning.destroy();
});

test('위치 데이터 실패는 갱신으로 재요청하지 않고 명시적 재시도 뒤에만 확정 집계를 표시한다', async () => {
  const { element, nodes } = fixture();
  let attempts = 0;
  const planning = mount({ element }, {
    loadRouteData: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('temporary failure'));
      return { points: [{ id: 'S1', lng: 127, lat: 37.5 }] };
    },
  });
  planning.update(data, 'S1');
  assert.equal(nodes['map-count'].textContent, '위치 데이터 확인 중');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(nodes['map-count'].textContent, '위치 데이터 미확인');
  assert.equal(nodes['map-status-text'].textContent, '배송지 위치 데이터를 불러오지 못했습니다.');
  assert.equal(nodes['map-retry'].hidden, false);

  planning.update({ ...data, simClock: '06:10' }, 'S1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(nodes['map-count'].textContent, '위치 데이터 미확인');

  nodes['map-retry'].listeners.click();
  assert.equal(nodes['map-count'].textContent, '위치 데이터 확인 중');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(nodes['map-count'].textContent, '지도 1곳 / 전체 위치 미등록 2곳 / 선택 차량 미등록 1곳');
  assert.equal(nodes['map-retry'].hidden, true);
  planning.destroy();
});

test('차량을 바꿔도 전체 주문 마커와 좌표를 유지하고 선택 차량 소속만 강조한다', async () => {
  const { element, nodes } = fixture();
  const live = Array.from({ length: 8 }, (_, index) => ({ id: `S${index + 1}`, vehicleId: 'V1', name: `주문 ${index + 1}`, boxes: 2 }));
  const unmapped = Array.from({ length: 35 }, (_, index) => ({ id: `V130-S${index + 1}`, vehicleId: 'V130', name: `미등록 ${index + 1}`, boxes: 2 }));
  const points = live.map((delivery, index) => ({ id: delivery.id, lng: 127 + index / 100, lat: 37.5 + index / 100 }));
  let created = 0;
  let removed = 0;
  const markerAttributes = new Map();
  const planning = mount({ element }, {
    loadRouteData: () => ({ points, legs: { 'MFC>S1': { coords: [[37.4, 127], [37.45, 127.01], [37.5, 127.02], [37.55, 127.03], [37.6, 127.04]] } } }),
    markerFactory: (_map, delivery) => {
      created += 1;
      const attributes = {};
      markerAttributes.set(delivery.id, attributes);
      return { element: { dataset: { orderMarker: delivery.id }, setAttribute(name, value) { attributes[name] = value; } }, remove() { removed += 1; } };
    },
  });
  planning.update({
    vehicle: vehicles[0],
    fleetVehicles: [vehicles[0], { id: 'V130', plate: '예시 차량 130' }],
    fleetDeliveries: [...live, ...unmapped],
  }, 'S1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 8);
  assert.equal(markerAttributes.get('S1')['data-selected-vehicle'], 'true');

  selectVehicle(nodes, 'V130');
  assert.equal(created, 8);
  assert.equal(removed, 0);
  assert.equal(markerAttributes.get('S1')['data-selected-vehicle'], 'false');
  assert.equal(nodes['map-count'].textContent, '지도 8곳 / 전체 위치 미등록 35곳 / 선택 차량 미등록 35곳');
  assert.equal(nodes['map-status'].hidden, true);

  selectVehicle(nodes, 'V1');
  assert.equal(created, 8);
  assert.equal(markerAttributes.get('S1')['data-selected-vehicle'], 'true');
  assert.equal(nodes['map-count'].textContent, '지도 8곳 / 전체 위치 미등록 35곳 / 선택 차량 미등록 0곳');
  planning.destroy();
});

test('주문 시나리오 버튼과 비교 입력 없이 지도와 핀배차만 표시한다', () => {
  const { element } = fixture();
  mount({ element });
  assert.doesNotMatch(element.innerHTML, /data-order-scenario-|data-order-volume-|data-order-target|비교 물량|물량 비율/);
  assert.match(element.innerHTML, /data-order-map-summary/);
  assert.match(element.innerHTML, /data-order-reassign-dialog/);
});

test('주문 화면은 운영 자료 좌표만 사용하고 데모 경로를 참조하지 않는다', () => {
  const source = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
  const body = source.match(/function syncDispatchContext\(\) \{[\s\S]*?\n\}\n\nfunction renderPage/)?.[0].replace(/\n\nfunction renderPage$/, '');
  assert.ok(body);
  assert.doesNotMatch(source, /scenarioTools|demo-shell|deliveryLinks/);
  assert.match(source, /function render\(\) \{\s*syncDispatchContext\(\);\s*renderPage\(\);/);
  assert.match(source, /if \(state\.page === 'orders'\) orderPlanning\.update\(state\.data, state\.selectedId, state\.dateContext\?\.date\);\s*if \(!state\.data\)/);
  assert.doesNotMatch(readFileSync(new URL('./order-planning.mjs', import.meta.url), 'utf8'), /\/scenario\/api/);
  const nodes = { 'page-description': { textContent: '' } };
  const state = { page: 'orders' };
  const context = { state, orderPlanning: { usesSource: () => false }, byId: id => nodes[id] };
  runInNewContext(body + '\nsyncDispatchContext();', context);
  context.orderPlanning.usesSource = () => true;
  runInNewContext('syncDispatchContext();', context);
  assert.match(nodes['page-description'].textContent, /배차 계산/);
});

test('차량 목록 선택과 외부 주문 선택은 실제 총량이나 각 주문의 수량을 바꾸지 않는다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'V2-S1');
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V2" aria-pressed="true"/);
  assert.match(nodes.selection.innerHTML, /주문 3/);
  assert.match(nodes['map-summary'].innerHTML, /총 40박스/);
  selectVehicle(nodes, 'V1');
  planning.update({ ...data, simClock: '06:10' }, 'V2-S1');
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V1" aria-pressed="true"/);
  assert.equal(nodes['map-count'].textContent, '위치 데이터 확인 중');
  assert.match(nodes['map-summary'].innerHTML, /총 40박스/);
  planning.destroy();
});

test('같은 주문의 배차 차량이 바뀌면 새 차량과 주문 선택을 따라간다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'S1');
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V1" aria-pressed="true"/);

  const reassigned = {
    ...data,
    fleetDeliveries: deliveries.map(delivery => delivery.id === 'S1' ? { ...delivery, vehicleId: 'V2' } : delivery),
  };
  planning.update(reassigned, 'S1');

  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V2" aria-pressed="true"/);
  assert.match(nodes.selection.innerHTML, /주문 1/);
  planning.destroy();
});

test('차량 목록은 같은 이름 배송원도 ID별 실제 주문량으로 나눈다', () => {
  const { element, nodes } = fixture();
  const sameNameVehicles = [
    { id: 'V1', plate: '차량 1', driver: '김배송' },
    { id: 'V2', plate: '차량 2', driver: '김배송' },
  ];
  const planning = mount({ element });
  planning.update({ fleetVehicles: sameNameVehicles, fleetDeliveries: deliveries });
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V1"[\s\S]*?2곳[\s\S]*?20박스/);
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V2"[\s\S]*?1곳[\s\S]*?20박스/);
  planning.destroy();
});

test('차량 목록은 고정 출발, 마지막 도착 ETA, 시뮬레이션 최종 인도 완료를 구분한다', () => {
  const { element, nodes } = fixture();
  mount({ element }).update({
    ...data,
    vehicle: { ...vehicles[0], departure: { time: '06:30', source: 'scenario-baseline' } },
    fleetVehicles: [{ ...vehicles[0], live: true, departure: { time: '06:30', source: 'scenario-baseline' } }, vehicles[1]],
    kpi: { finishEta: '09:20', vehicleTiming: { source: 'simulation', departureMs: 23_400_000, completionMs: 35_100_000, remainingSeconds: 7_200, durationSeconds: 11_700, completed: false, heldStops: 0, estimatedStops: 2 } },
  }, 'S1');
  assert.match(nodes.vehicle.innerHTML, /고정 출발 \(시나리오 기준\) <strong>06:30/);
  assert.match(nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>09:20/);
  assert.match(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>09:45 예상/);
  assert.doesNotMatch(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>09:20/);
  assert.match(nodes['map-summary'].innerHTML, /총 40박스/);

  const completed = fixture();
  const completedPlanning = mount(completed);
  completedPlanning.update({
    ...data,
    vehicle: { ...vehicles[0], live: true },
    fleetVehicles: [{ ...vehicles[0], live: true }, vehicles[1]],
    kpi: { finishEta: '09:20 완료', vehicleTiming: { source: 'simulation', departureMs: 23_400_000, completionMs: 35_100_000, remainingSeconds: 0, durationSeconds: 11_700, completed: true, heldStops: 0, estimatedStops: 2 } },
  }, 'S1');
  assert.match(completed.nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>ETA 미해당/);
  assert.doesNotMatch(completed.nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>09:20 완료/);
  assert.match(completed.nodes.vehicle.innerHTML, /최종 인도 완료 <strong>09:45 완료/);
  completedPlanning.destroy();
});

test('보류 배송지가 있으면 차량 완료 시간을 확정하지 않는다', () => {
  const { element, nodes } = fixture();
  mount({ element }).update({
    ...data,
    vehicle: { ...vehicles[0], live: true },
    fleetVehicles: [{ ...vehicles[0], live: true }, vehicles[1]],
    kpi: { finishEta: '09:20', vehicleTiming: { source: 'simulation', departureMs: 23_400_000, completionMs: 35_100_000, remainingSeconds: 7_200, durationSeconds: 11_700, completed: false, heldStops: 1, estimatedStops: 1 } },
  }, 'S1');
  assert.match(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>보류 1곳, 미확인/);
});

test('최종 완료 시각은 분 단위로 반올림하고 자정을 넘긴 일수를 보존한다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  const timed = completionMs => ({
    ...data,
    vehicle: { ...vehicles[0], live: true },
    fleetVehicles: [{ ...vehicles[0], live: true }, vehicles[1]],
    kpi: { finishEta: '23:50', vehicleTiming: { source: 'simulation', departureMs: 23_400_000, completionMs, remainingSeconds: 1_000, durationSeconds: (completionMs - 23_400_000) / 1000, completed: false, heldStops: 0, estimatedStops: 1 } },
  });
  planning.update(timed(86_430_001), 'S1');
  assert.match(nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>23:50/);
  assert.match(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>다음날 00:01 예상/);
  planning.update(timed(173_700_000), 'S1');
  assert.match(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>\+2일 00:15 예상/);
  planning.destroy();
});

test('데이터가 바뀌면 실제 총량을 갱신하고 미확인 수량을 보존한다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'S1');
  const changed = { ...data, fleetVehicles: [{ id: 'V1', plate: '새 차량' }], fleetDeliveries: [{ id: 'S1', vehicleId: 'V1', name: '새 주문', boxes: 20000 }] };
  planning.update(changed, 'S1');
  assert.match(nodes['map-summary'].innerHTML, /총 20,000박스/);
  assert.match(nodes['map-summary'].innerHTML, /차량 1대/);
  planning.update({ ...changed, fleetDeliveries: [{ id: 'S1', vehicleId: 'V1' }] }, 'S1');
  assert.match(nodes['map-summary'].innerHTML, /총 미확인/);
  assert.match(nodes.vehicle.innerHTML, /미확인/);
  planning.update({ ...changed, fleetDeliveries: [], deliveries }, 'S1');
  assert.match(nodes['map-summary'].innerHTML, /총 0박스/);
  planning.destroy();
});

test('날짜 자료는 모든 주문을 GPU 레이어에 유지하고 선택이 V1 명령으로 전달되지 않는다', () => {
  const { element, nodes } = fixture();
  const orders = Array.from({ length: 5000 }, (_, index) => ({ id: `import-${index}`, orderNumber: String(index), name: `주문 ${index}`, vehicleId: index % 2 ? 'group-a' : 'group-b', boxes: 1, coordinates: [127 + (index % 50) / 1000, 37.5], zoneIds: ['zone-a'] }));
  let routeCalls = 0, legacySelects = 0, picks;
  const updates = [];
  const planning = mount({ element }, {
    loadRouteData: () => { routeCalls++; return { points: [] }; },
    onSelect: () => { legacySelects++; },
    layerFactory: (_map, callbacks) => { picks = callbacks.onPick; return { update: value => updates.push(value), destroy() {} }; },
  });
  const input = {
    dispatchSource: { date: '2025-09-12', summary: { orders: 5000, boxes: 5000 } },
    dispatchRegions: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { zoneId: 'zone-a', label: '검증 구역', quality: 'REVIEW', baseDate: '20250630' } }] },
    fleetVehicles: [{ id: 'group-a', driver: '기사 A' }, { id: 'group-b', driver: '기사 B' }], fleetDeliveries: orders,
  };
  const before = structuredClone(input);
  planning.update(input, null);
  assert.equal(routeCalls, 0);
  const points = updates.at(-1).points;
  assert.equal(points.features.length, 5000);
  assert.equal(updates.at(-1).selectedGroupId, null);
  selectVehicle(nodes, 'group-a');
  assert.equal(updates.at(-1).points, points);
  assert.equal(updates.at(-1).selectedGroupId, 'group-a');
  assert.equal(nodes['map-canvas'].dataset.orderPointCount, '5000');
  picks(['import-2', 'import-52']);
  assert.match(nodes.selection.innerHTML, /이 지점의 주문 2건/);
  assert.match(nodes.selection.innerHTML, /data-order-overlap/);
  assert.equal(legacySelects, 1, '차량 선택은 뷰어 연결용으로 전달하되 V1 명령은 만들지 않는다');
  assert.doesNotMatch(nodes.selection.innerHTML, /선택 주문 2|배송 구역|zone-a/);
  planning.update(input, 'import-2');
  picks([]);
  planning.update(input, 'import-2');
  assert.match(nodes.selection.innerHTML, /지도에서 주문을 선택해 주세요/);
  assert.equal(updates.at(-1).selectedOrderId, null);
  assert.equal(updates.at(-1).selectedGroupId, null);
  assert.deepEqual(updates.at(-1).selectedZoneIds, []);
  assert.equal(updates.at(-1).points.features.length, 5000);
  assert.deepEqual(input, before);
  planning.destroy();
});

test('핀배차는 같은 배송지 주문 전체를 초안에서만 이동하고 취소는 유지한다', async () => {
  const { element, nodes } = fixture();
  let current = importedPlanningData();
  current.dispatch = { phase: 'draft', readOnly: false, candidateIds: ['G1', 'G2'] };
  current.fleetDeliveries = current.fleetDeliveries.map(item => ({ ...item, assignmentUnitId: item.id === 'O3' ? 'D2' : 'D1' }));
  const original = structuredClone(current);
  const assignments = [];
  let picks, legacySelects = 0, planning;
  const onAssign = ({ orderIds, targetGroupId }) => {
    assignments.push({ orderIds: [...orderIds], targetGroupId });
    const moved = new Set(orderIds);
    const changed = current.fleetDeliveries.filter(item => moved.has(item.id) && item.vehicleId !== targetGroupId);
    current = {
      ...current,
      fleetDeliveries: current.fleetDeliveries.map(item => moved.has(item.id)
        ? { ...item, currentGroupId: targetGroupId, vehicleId: targetGroupId, driver: current.fleetVehicles.find(vehicle => vehicle.id === targetGroupId).driver }
        : item),
    };
    planning.update(current, null);
    return { changedCount: changed.length, changedBoxes: changed.reduce((sum, item) => sum + item.boxes, 0), persisted: true };
  };
  planning = mount({ element }, {
    onAssign,
    onSelect: () => { legacySelects += 1; },
    layerFactory: (_map, callbacks) => { picks = callbacks.onPick; return { update() {}, destroy() {} }; },
  });
  planning.update(current, null);
  assert.equal(nodes['dispatch-actions'].hidden, false);
  assert.doesNotMatch(element.innerHTML, /data-order-dispatch-all/);
  assert.equal(nodes['dispatch-pin'].disabled, true);

  selectVehicle(nodes, 'G1');
  picks(['O1']);
  nodes['dispatch-pin'].listeners.click();
  assert.equal(nodes['reassign-dialog'].open, true);
  assert.match(nodes['reassign-from'].textContent, /2건.*10박스/);
  nodes['reassign-target'].value = 'G2'; nodes['reassign-target'].listeners.change();
  assert.match(nodes['reassign-preview'].textContent, /현재 1건 \/ 11박스 → 배차 후 3건 \/ 21박스/);
  nodes['reassign-cancel'].listeners.click();
  assert.equal(nodes['reassign-dialog'].open, false);
  assert.deepEqual(assignments, []);
  assert.deepEqual(current, original);

  nodes['dispatch-pin'].listeners.click();
  nodes['reassign-target'].value = 'G2'; nodes['reassign-target'].listeners.change();
  await nodes['reassign-confirm'].listeners.click();
  assert.deepEqual(assignments[0], { orderIds: ['O1', 'O2'], targetGroupId: 'G2' });
  assert.match(nodes['dispatch-result'].textContent, /2건 \/ 10박스/);
  assert.deepEqual(current.fleetDeliveries.map(item => [item.id, item.vehicleId]), [['O1', 'G2'], ['O2', 'G2'], ['O3', 'G2']]);

  picks(['O3']);
  assert.equal(nodes['dispatch-pin'].disabled, false);
  nodes['dispatch-pin'].listeners.click();
  assert.match(nodes['reassign-from'].textContent, /1건.*11박스/);
  nodes['reassign-target'].value = 'G1'; nodes['reassign-target'].listeners.change();
  assert.match(nodes['reassign-preview'].textContent, /현재 0건 \/ 0박스 → 배차 후 1건 \/ 11박스/);
  await nodes['reassign-confirm'].listeners.click();
  assert.deepEqual(assignments[1], { orderIds: ['O3'], targetGroupId: 'G1' });
  assert.equal(current.fleetDeliveries.find(item => item.id === 'O3').vehicleId, 'G1');
  assert.equal(legacySelects, 2, '지도 선택만 전달하며 차량 선택은 운행 명령을 만들지 않는다');
  current.dispatch = { ...current.dispatch, phase: 'published' };
  planning.update(current, null);
  assert.equal(nodes['dispatch-pin'].disabled, true);
  nodes['dispatch-pin'].listeners.click();
  assert.equal(nodes['reassign-dialog'].open, false);
  current.dispatch = { ...current.dispatch, phase: 'amending', hasChanges: false };
  planning.update(current, null);
  assert.equal(nodes['dispatch-pin'].disabled, false);
  assert.match(nodes['dispatch-context'].textContent, /변경 배차를 다시 전송/);
  current.fleetDeliveries = current.fleetDeliveries.map(item => item.assignmentUnitId === 'D2' ? { ...item, assignmentProtected: true } : item);
  planning.update(current, null);
  assert.equal(nodes['dispatch-pin'].disabled, true);
  assert.match(nodes['dispatch-context'].textContent, /진행 중이거나 완료된/);
  nodes['dispatch-pin'].listeners.click();
  assert.equal(nodes['reassign-dialog'].open, false);
  current.dispatch = { ...current.dispatch, phase: 'draft', readOnly: true };
  planning.update(current, null);
  assert.equal(nodes['dispatch-pin'].disabled, true);
  assert.deepEqual(current.dispatchSource, original.dispatchSource);
  assert.equal(current.fleetVehicles.some(vehicle => vehicle.id === 'V1'), false);
  planning.destroy();
});

test('핀배차 대상의 박스 수가 미확인이면 배차 후 미리보기도 미확인으로 남긴다', () => {
  const { element, nodes } = fixture();
  const input = importedPlanningData();
  input.dispatch = { phase: 'draft', readOnly: false, candidateIds: ['G1', 'G2'] };
  input.fleetDeliveries[2] = { ...input.fleetDeliveries[2], boxes: undefined };
  let pick;
  const planning = mount({ element }, {
    onAssign: () => ({}),
    layerFactory: (_map, callbacks) => { pick = callbacks.onPick; return { update() {}, destroy() {} }; },
  });
  planning.update(input, null);
  pick(['O1']);
  nodes['dispatch-pin'].listeners.click();
  nodes['reassign-target'].value = 'G2';
  nodes['reassign-target'].listeners.change();
  assert.match(nodes['reassign-preview'].textContent, /현재 1건 \/ 미확인 → 배차 후 2건 \/ 미확인/);
  planning.destroy();
});

test('GPU 레이어 오류는 그대로 보이고 재시도와 날짜 변경에서 새 레이어로 복구한다', () => {
  const { element, nodes } = fixture();
  const layers = [];
  let failNext = true;
  const planning = mount({ element }, {
    onAssign: () => ({ changedCount: 0, changedBoxes: 0, persisted: false }),
    layerFactory: (_map, callbacks) => {
      const layer = {
        callbacks,
        destroyed: false,
        updates: 0,
        update() {
          this.updates += 1;
          if (failNext) { failNext = false; callbacks.onError(new Error('레이어 검증 실패')); }
        },
        destroy() { this.destroyed = true; },
      };
      layers.push(layer);
      return layer;
    },
  });
  const first = importedPlanningData('2025-09-15');
  planning.update(first, null);
  assert.equal(layers.length, 1);
  assert.equal(nodes['map-status-text'].textContent, '레이어 검증 실패');
  assert.equal(nodes['map-retry'].hidden, false);
  assert.equal(nodes['map-count'].textContent, '지도 사용 불가');

  planning.update({ ...first }, null);
  assert.equal(layers.length, 1);
  assert.equal(nodes['map-status-text'].textContent, '레이어 검증 실패');
  nodes['map-retry'].listeners.click();
  assert.equal(layers[0].destroyed, true);
  assert.equal(layers.length, 2);
  assert.equal(layers[1].updates > 0, true);
  assert.equal(nodes['map-status'].hidden, true);

  layers[1].callbacks.onError(new Error('두 번째 실패'));
  assert.equal(nodes['map-status-text'].textContent, '두 번째 실패');
  planning.update(importedPlanningData('2025-09-16'), null);
  assert.equal(layers[1].destroyed, true);
  assert.equal(layers.length, 3);
  assert.equal(layers[2].updates > 0, true);
  assert.equal(nodes['map-status'].hidden, true);
  assert.equal(nodes['map-canvas'].dataset.orderDate, '2025-09-16');
  planning.destroy();
});

test('첫 클릭은 선택만 하고 선택 차량 재클릭에만 줌을 맞추며 일반 갱신은 카메라를 유지한다', () => {
  const { element, nodes } = fixture();
  const cameras = [];
  const planning = mount({ element }, {
    mapFactory: () => ({ resize() {}, remove() {}, fitBounds: (...args) => cameras.push(['bounds', ...args]), jumpTo: value => cameras.push(['point', value]) }),
    layerFactory: () => ({ update() {}, destroy() {} }),
  });
  const input = importedPlanningData();
  input.fleetVehicles.push({ id: 'G3', driver: '위치 없는 기사' });
  const before = structuredClone(input);
  planning.update(input, null);
  cameras.length = 0;
  selectVehicle(nodes, 'G1');
  assert.equal(cameras.length, 0);
  planning.update(input, null);
  assert.equal(cameras.length, 0);
  selectVehicle(nodes, 'G1');
  assert.deepEqual(cameras[0], ['bounds', [[127.1, 37.5], [127.2, 37.6]], { padding: { top: 72, bottom: 92, left: 48, right: 48 }, maxZoom: 15, duration: 0 }]);
  planning.update(input, null);
  assert.equal(cameras.length, 1);
  selectVehicle(nodes, 'G1');
  assert.equal(cameras.length, 2);
  assert.deepEqual(cameras[1], cameras[0]);
  selectVehicle(nodes, 'G2');
  assert.equal(cameras.length, 2);
  selectVehicle(nodes, 'G2');
  assert.deepEqual(cameras.at(-1), ['point', { center: [127.3, 37.7], zoom: 15 }]);
  selectVehicle(nodes, 'G3');
  selectVehicle(nodes, 'G3');
  assert.equal(cameras.length, 3);
  selectVehicle(nodes, 'all');
  assert.equal(cameras.length, 3);
  selectVehicle(nodes, 'all');
  assert.deepEqual(cameras.at(-1)[1], [[127.1, 37.5], [127.3, 37.7]]);
  assert.deepEqual(input, before);
  assert.equal(nodes['map-canvas'].dataset.orderPointCount, '3');
  planning.destroy();
});

test('권역·주문 보기는 주문 원본과 카메라를 유지하며 날짜/차량 변경 뒤에도 선택 모드를 보존한다', () => {
  const { element, nodes } = fixture();
  const updates = [], cameras = [];
  const planning = mount({ element }, {
    mapFactory: () => ({ resize() {}, remove() {}, fitBounds: (...args) => cameras.push(args), jumpTo: value => cameras.push(value) }),
    layerFactory: () => ({ update: value => updates.push(value), destroy() {} }),
  });
  const input = importedPlanningData();
  const before = structuredClone(input);
  planning.update(input, null);
  const points = updates.at(-1).points;
  assert.equal(updates.at(-1).mode, 'regions');
  assert.equal(updates.at(-1).regions.features[0].properties.orderCount, 3);
  assert.equal(nodes['map-mode-control'].hidden, false);
  assert.equal(nodes.selection.hidden, true);
  cameras.length = 0;
  nodes['map-mode-control'].listeners.change({ target: { matches: () => true, value: 'orders' } });
  assert.equal(updates.at(-1).mode, 'orders');
  assert.equal(updates.at(-1).points, points);
  assert.equal(cameras.length, 0);
  assert.equal(nodes.selection.hidden, false);
  assert.equal(nodes['map-description'].textContent, '모든 주문 핀을 표시합니다.');
  selectVehicle(nodes, 'G1');
  assert.equal(updates.at(-1).mode, 'orders');
  assert.equal(updates.at(-1).selectedGroupId, 'G1');
  assert.equal(cameras.length, 0);
  planning.update(importedPlanningData('2025-09-16'), null);
  assert.equal(updates.at(-1).mode, 'orders');
  cameras.length = 0;
  nodes['map-mode-control'].listeners.change({ target: { matches: () => true, value: 'regions' } });
  assert.equal(updates.at(-1).mode, 'regions');
  assert.equal(cameras.length, 0);
  assert.match(nodes['map-description'].textContent, /확대하면/);
  assert.equal(nodes.selection.hidden, true);
  assert.deepEqual(input, before);
  planning.destroy();
});

test('계산안은 배정 차량만 집계하고 같은 배송지 주문은 한 곳과 원래 박스로 표시한다', () => {
  const source = importedPlanningData('2026-09-16');
  source.dispatch = { phase: 'draft', candidateIds: ['G1'] };
  source.fleetDeliveries = source.fleetDeliveries.map((order, index) => ({ ...order, vehicleId: 'G1', status: 'pending', ...(index === 1 ? { name: '주문 1', address: '서울 1' } : {}) }));
  const before = structuredClone(source);
  const { element, nodes } = fixture();
  let pinCount = 0;
  const planning = mount({ element }, { layerFactory: () => ({ update({ points }) { pinCount = points.features.length; }, destroy() {} }) });
  planning.update(source);
  assert.match(nodes['map-summary'].innerHTML, /주문 3건/);
  assert.match(nodes['map-summary'].innerHTML, /총 21박스/);
  assert.match(nodes.vehicle.innerHTML, /2곳 \/ 주문 3건/);
  assert.doesNotMatch(nodes.vehicle.innerHTML, /data-order-vehicle-id="G2"/);
  assert.equal(pinCount, 3);
  assert.deepEqual(source, before);
  planning.destroy();
});
