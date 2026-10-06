import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptOperations, calculatedEtaText } from './operations-adapter.mjs';
import { sourceVehicleContext } from './source-context.mjs';
import { mountRouteEditor } from './route-editor.mjs';

function nativeState() {
  return {
    boot: 'native-boot', revision: 7,
    sourceData: { date: '2026-09-16', defaultVehicleId: 'V1', defaultStopId: 'O2' },
    fleetVehicles: [{ id: 'V1' }, { id: 'V2' }],
    vehicleStates: { V1: { truck: { fromId: 'O2', toId: 'O2', atStopId: 'O2' } } },
    vehicle: { id: 'V1' },
    fleetDeliveries: [
      { id: 'O1', vehicleId: 'V1', name: '매장', address: '서울', boxes: 2, status: 'pending' },
      { id: 'O2', vehicleId: 'V1', name: '매장', address: '서울', boxes: 3, status: 'current' },
      { id: 'O3', vehicleId: 'V2', name: '매장', address: '서울', boxes: 4, status: 'pending' },
    ],
    deliveries: [], dispatchOrders: [{ id: 'O1' }, { id: 'O2' }], customerStopId: 'O2',
    truck: { fromId: 'MFC', toId: 'O2', atStopId: null },
  };
}

test('운영 어댑터는 원본 주문과 CAS 기준을 보존하고 배송지 표시와 위치 ID만 묶는다', () => {
  const raw = nativeState(), before = structuredClone(raw);
  const data = adaptOperations(raw);
  assert.deepEqual(raw, before);
  assert.equal(data.sourceOrders, raw.fleetDeliveries);
  assert.deepEqual(data.sourceOrders.map(order => order.id), ['O1', 'O2', 'O3']);
  assert.deepEqual(data.fleetDeliveries.map(stop => stop.orderIds), [['O1', 'O2'], ['O3']]);
  assert.deepEqual(data.deliveries.map(stop => [stop.id, stop.boxes, stop.status]), [['O1', 5, 'current']]);
  assert.equal(data.customerStopId, 'O1');
  assert.equal(data.sourceData.defaultStopId, 'O1');
  assert.deepEqual(data.dispatchOrders, raw.dispatchOrders);
  assert.equal(data.boot, 'native-boot'); assert.equal(data.revision, 7);
  assert.deepEqual(data.truck, { fromId: 'MFC', toId: 'O1', atStopId: null });
  assert.deepEqual(data.vehicleStates.V1.truck, { fromId: 'O1', toId: 'O1', atStopId: 'O1' });
});

test('주문이 없는 원본 운영 상태는 차량이나 배송지를 생성하지 않는다', () => {
  const data = adaptOperations({ sourceData: { date: '2026-10-06' }, fleetDeliveries: [], fleetVehicles: [], vehicleStates: {} });
  assert.deepEqual(data.fleetDeliveries, []);
  assert.deepEqual(data.deliveries, []);
  assert.deepEqual(data.fleetVehicles, []);
  assert.deepEqual(data.vehicleStates, {});
  assert.equal(data.customerStopId, null);
});

test('시뮬레이션과 불완전한 원본 계약은 제품 배송 상태로 변환하지 않는다', () => {
  const valid = nativeState();
  for (const snapshot of [
    null, { order: [], fleet: { vehicles: [], deliveries: [] } },
    { ...valid, sourceData: null }, { ...valid, sourceData: 'invalid' }, { ...valid, sourceData: [] },
    { ...valid, sourceData: { date: '2026-02-30' } },
    { ...valid, fleetDeliveries: null }, { ...valid, fleetVehicles: null },
    { ...valid, vehicleStates: null }, { ...valid, vehicleStates: 1 }, { ...valid, vehicleStates: [] },
  ]) assert.throws(() => adaptOperations(snapshot), /배송 자료/);
});

test('미등록 선택과 위치 ID는 가상 배송지를 생성하지 않고 수신 정보를 보존한다', () => {
  const raw = nativeState();
  raw.sourceData.defaultStopId = 'missing'; raw.customerStopId = 'missing';
  raw.truck = { fromId: 'depot', toId: 'old-stop', atStopId: null };
  const data = adaptOperations(raw);
  assert.equal(data.sourceData.defaultStopId, null);
  assert.equal(data.customerStopId, null);
  assert.deepEqual(data.truck, raw.truck);
  assert.equal(data.fleetDeliveries.length, 2);
});

test('원본 ETA와 운영 예상, 다음날 표시와 결측은 실제 배송 순서 화면까지 유지한다', t => {
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const raw = nativeState();
  raw.sourceData.defaultStopId = 'O1';
  raw.customerStopId = 'O1';
  raw.fleetDeliveries = [
    { id: 'O1', vehicleId: 'V1', name: '제공 ETA', address: '서울 1', status: 'pending', coordinates: [127, 37.5], calculatedEta: '23:58', preciseTimeText: '23:58', etaSource: 'provider' },
    { id: 'O2', vehicleId: 'V1', name: '운영 예상', address: '서울 2', status: 'pending', coordinates: [127, 37.5] },
    { id: 'O3', vehicleId: 'V1', name: '좌표 미등록', address: '서울 3', status: 'pending', coordinates: null },
  ];
  const before = structuredClone(raw);
  const view = sourceVehicleContext(adaptOperations(raw), 'O1');
  assert.deepEqual(view.deliveries.map(stop => [stop.id, calculatedEtaText(stop)]), [
    ['O1', '23:58'], ['O2', '다음날 00:02'], ['O3', '미확인'],
  ]);
  assert.equal(view.deliveries[0].etaSource, 'provider');
  assert.equal(view.deliveries[1].etaSource, 'operating-plan');
  assert.deepEqual(raw, before);
  const list = { scrollTop: 0 };
  const element = { innerHTML: '', contains: () => false, addEventListener() {},
    querySelector: selector => selector === '.route-list' ? list : null };
  mountRouteEditor({ element, onSend() {}, onSelect() {} }).update(view, 'O1', true);
  for (const eta of ['23:58', '다음날 00:02', '미확인']) assert.ok(element.innerHTML.includes(`ETA ${eta}`));
});
