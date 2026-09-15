import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeScenario, orderAssignmentSummary, orderMapModel, mountOrderPlanning } from './order-planning.mjs';

class FakeNode {
  constructor() { this.innerHTML = ''; this.value = ''; this.textContent = ''; this.listeners = {}; this.dataset = {}; this.open = false; this.focused = false; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
}

function fixture() {
  const names = ['vehicle', 'map-canvas', 'map-layer', 'map-status', 'map-status-text', 'map-retry', 'map-count', 'selection', 'map-summary', 'scenario-dialog', 'scenario-open', 'scenario-close', 'volume-range', 'volume-number', 'volume-display', 'baseline', 'target', 'total-vehicles', 'total-destinations', 'assignments', 'volume-note'];
  const nodes = Object.fromEntries(names.map(name => [name, new FakeNode()]));
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
const input = (nodes, name, value, type = 'input') => nodes[name].listeners[type]({ target: { value: String(value) } });
const selectVehicle = (nodes, id) => nodes.vehicle.listeners.click({ target: { closest: () => ({ dataset: { orderVehicleId: id } }) } });

test('입력 물량을 100%로 삼고 80~120%의 합계만 미리 계산한다', () => {
  for (const [percent, targetBoxes] of [[80, 32], [100, 40], [120, 48]]) {
    assert.deepEqual(volumeScenario(deliveries, percent), { percent, baselineBoxes: 40, targetBoxes });
  }
  assert.deepEqual(volumeScenario([{ boxes: 12345 }], 120), { percent: 120, baselineBoxes: 12345, targetBoxes: 14814 });
  assert.equal(volumeScenario([{ boxes: 7 }], 110).targetBoxes, 8);
  assert.equal(volumeScenario(deliveries, 0).percent, 80);
  assert.equal(volumeScenario(deliveries, 999).percent, 120);
  assert.equal(volumeScenario(deliveries, '').percent, 100);
});

test('확인된 0과 빈 목록은 0이며 누락되거나 잘못된 수량을 0으로 만들지 않는다', () => {
  assert.equal(volumeScenario([], 120).targetBoxes, 0);
  assert.equal(volumeScenario([{ boxes: 0 }], 80).baselineBoxes, 0);
  for (const source of [undefined, null, [{ boxes: null }], [{}], [{ boxes: -1 }], [{ boxes: Infinity }], [{ boxes: '8' }], [{ boxes: 8 }, {}]]) {
    assert.equal(volumeScenario(source).baselineBoxes, null);
    assert.equal(volumeScenario(source).targetBoxes, null);
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

test('물량 비율 입력과 슬라이더에 이름과 80~120 경계를 제공한다', () => {
  const { element, nodes } = fixture();
  mount({ element });
  assert.match(element.innerHTML, /min="80" max="120" step="1" value="100" aria-label="물량 비율 슬라이더"/);
  assert.match(element.innerHTML, /min="80" max="120" step="1" value="100" inputmode="numeric" aria-label="물량 비율 입력"/);
  assert.doesNotMatch(element.innerHTML, /7800|7,800|60박스 기준|배송원 수 입력|차량 이동 시점/);
  assert.equal(nodes['volume-range'].disabled, true);
});

test('차량 목록 선택과 외부 주문 선택은 기준 총량이나 각 주문의 수량을 바꾸지 않는다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'V2-S1');
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V2" aria-pressed="true"/);
  assert.match(nodes.selection.innerHTML, /주문 3/);
  assert.equal(nodes.baseline.textContent, '40박스');
  selectVehicle(nodes, 'V1');
  planning.update({ ...data, simClock: '06:10' }, 'V2-S1');
  assert.match(nodes.vehicle.innerHTML, /data-order-vehicle-id="V1" aria-pressed="true"/);
  assert.equal(nodes['map-count'].textContent, '위치 데이터 확인 중');
  assert.equal(nodes.baseline.textContent, '40박스');
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

test('주문 시나리오는 배송지와 박스를 차량 ID별로 합산하고 같은 이름 배송원을 합치지 않는다', () => {
  const sameNameVehicles = [
    { id: 'V1', plate: '차량 1', driver: '김배송' },
    { id: 'V2', plate: '차량 2', driver: '김배송' },
  ];
  const summary = orderAssignmentSummary({ fleetVehicles: sameNameVehicles, fleetDeliveries: deliveries });
  assert.equal(summary.vehicles, 2);
  assert.equal(summary.destinations, 3);
  assert.equal(summary.boxes, 40);
  assert.deepEqual(summary.assignments.map(item => [item.vehicle.id, item.destinations, item.boxes]), [['V1', 2, 20], ['V2', 1, 20]]);
});

test('차량 목록은 고정 시나리오 출발, 마지막 도착 ETA, 최종 인도 완료 예측을 구분한다', () => {
  const { element, nodes } = fixture();
  mount({ element }).update({
    ...data,
    vehicle: { ...vehicles[0], departure: { time: '06:30', source: 'scenario-baseline' } },
    fleetVehicles: [{ ...vehicles[0], departure: { time: '06:30', source: 'scenario-baseline' } }, vehicles[1]],
    kpi: { finishEta: '09:20' },
  }, 'S1');
  assert.match(nodes.vehicle.innerHTML, /고정 출발 \(시나리오 기준\) <strong>06:30/);
  assert.match(nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>09:20/);
  assert.match(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>미등록/);
  assert.doesNotMatch(nodes.vehicle.innerHTML, /최종 인도 완료 예측 <strong>09:20/);
  assert.equal(nodes['total-vehicles'].textContent, '2대');
  assert.equal(nodes['total-destinations'].textContent, '3곳');
  assert.match(nodes.assignments.innerHTML, /배정 배송지 2곳/);
  assert.doesNotMatch(nodes.assignments.innerHTML, /가구/);

  const completed = fixture();
  const completedPlanning = mount(completed);
  completedPlanning.update({ ...data, kpi: { finishEta: '09:20 완료' } }, 'S1');
  assert.match(completed.nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>ETA 미해당/);
  assert.doesNotMatch(completed.nodes.vehicle.innerHTML, /마지막 도착 ETA <strong>09:20 완료/);
  completedPlanning.destroy();
});

test('비율 입력은 원본 상태와 지도 주문 수량을 보존하고 복귀 버튼은 없다', () => {
  const original = structuredClone(data);
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'S1');
  input(nodes, 'volume-range', 80);
  assert.equal(nodes.target.textContent, '32박스');
  assert.equal(nodes['volume-number'].value, '80');
  input(nodes, 'volume-range', 120);
  assert.equal(nodes.target.textContent, '48박스');
  assert.match(nodes.selection.innerHTML, /8박스/);
  assert.deepEqual(data, original);
  assert.doesNotMatch(element.innerHTML, /data-order-volume-reset|100%로 돌아가기/);
  input(nodes, 'volume-range', 100);
  assert.equal(nodes.target.textContent, '40박스');
  assert.equal(nodes['volume-number'].value, '100');
  nodes['scenario-open'].listeners.click();
  assert.equal(nodes['scenario-dialog'].open, true);
  nodes['scenario-close'].listeners.click();
  assert.equal(nodes['scenario-open'].focused, true);
  planning.destroy();
});

test('120 입력 중의 1과 12는 강제로 80으로 바뀌지 않고 확정 시 범위를 지킨다', () => {
  const { element, nodes } = fixture();
  mount({ element }).update(data, 'S1');
  input(nodes, 'volume-number', 1);
  input(nodes, 'volume-number', 12);
  assert.equal(nodes.target.textContent, '40박스');
  input(nodes, 'volume-number', 120);
  assert.equal(nodes.target.textContent, '48박스');
  input(nodes, 'volume-number', 20, 'change');
  assert.equal(nodes['volume-number'].value, '80');
  input(nodes, 'volume-number', '', 'change');
  assert.equal(nodes['volume-number'].value, '100');
});

test('데이터가 바뀌면 새 총량으로 계산하고 비율과 필터를 유지한다', () => {
  const { element, nodes } = fixture();
  const planning = mount({ element });
  planning.update(data, 'S1');
  input(nodes, 'volume-range', 120);
  const changed = { ...data, fleetVehicles: [{ id: 'V1', plate: '새 차량' }], fleetDeliveries: [{ id: 'S1', vehicleId: 'V1', name: '새 주문', boxes: 20000 }] };
  planning.update(changed, 'S1');
  assert.equal(nodes.baseline.textContent, '20,000박스');
  assert.equal(nodes.target.textContent, '24,000박스');
  assert.equal(nodes['volume-number'].value, '120');
  assert.match(nodes['map-summary'].innerHTML, /차량 1대/);
  planning.update({ ...changed, fleetDeliveries: [{ id: 'S1', vehicleId: 'V1' }] }, 'S1');
  assert.equal(nodes.baseline.textContent, '미확인');
  assert.equal(nodes.target.textContent, '미확인');
  assert.equal(nodes['volume-range'].disabled, true);
  planning.update({ ...changed, fleetDeliveries: [], deliveries }, 'S1');
  assert.equal(nodes.baseline.textContent, '0박스');
  assert.equal(nodes['volume-range'].disabled, false);
  planning.destroy();
});
