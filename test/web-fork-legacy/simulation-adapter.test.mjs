import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSimulation, customerHeadline, publishedEtaText } from '../../apps/web/combined/simulation-adapter.mjs';
import { createRequire } from 'node:module';
const { OperatingSimulation } = createRequire(import.meta.url)('../../lib/operating-simulation');

test('customer requests retain exact stop identity and distinguish missing synthetic data', () => {
  const snapshot = new OperatingSimulation(() => {}).snapshot();
  const data = adaptSimulation(snapshot);
  const s4 = data.deliveries.find(stop => stop.id === 'S4');
  assert.deepEqual(s4.customerRequests, snapshot.order.find(stop => stop.id === 'S4').customerRequests);
  assert.deepEqual(s4.customerRequests.items.map(item => item.id), ['S4-refrigerator', 'S4-handoff']);
  assert.deepEqual(data.deliveries.find(stop => stop.id === 'S5').customerRequests.items, []);
  assert.equal(data.fleetDeliveries.find(stop => stop.vehicleId === 'V2').customerRequests, null);
  s4.customerRequests.items[0].label = 'changed';
  assert.notEqual(snapshot.order.find(stop => stop.id === 'S4').customerRequests.items[0].label, 'changed');
});

test('미주문 배송은 사전 계산된 고객 ETA를 공개 값으로 표시하지 않는다', () => {
  const delivery = { ordered: false, officialEta: { time: '07:10' }, customerStatus: { key: 'unordered', label: '주문 전' } };
  assert.equal(publishedEtaText(delivery), '미확인');
  assert.equal(customerHeadline(delivery), '주문 접수 전입니다.');
});

test('고객 문구는 출고 준비와 배송 진행을 구분한다', () => {
  assert.equal(customerHeadline({ customerStatus: { key: 'picking', label: '피킹 중' } }), '상품을 준비하고 있습니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'staged', label: '상차 대기' } }), '상차를 기다리고 있습니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'shipping', label: '배송 중' } }), '상품이 배송 중입니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'nearby', label: '인근 배송 중' } }), '인근에서 배송 중입니다.');
});

test('고객 공개 ETA는 정확 시각 대신 약속 시간대를 우선한다', () => {
  assert.equal(publishedEtaText({
    ordered: true,
    preciseTimeText: '08:35',
    customerWindowText: '08:05 ~ 09:05',
    officialEta: { time: '08:35' },
  }), '08:05 ~ 09:05');
});

test('원본 배차 상태는 주문을 보존하고 운행 화면만 물리 배송지로 투영한다', () => {
  const raw = {
    sourceData: { date: '2026-09-16', defaultVehicleId: 'V1', defaultStopId: 'O2' },
    fleetVehicles: [{ id: 'V1' }, { id: 'V2' }], vehicleStates: { V1: { truck: { fromId: 'O2', toId: 'O2', atStopId: 'O2' } } }, vehicle: { id: 'V1' },
    fleetDeliveries: [
      { id: 'O1', vehicleId: 'V1', name: '매장', address: '서울', boxes: 2, status: 'pending' },
      { id: 'O2', vehicleId: 'V1', name: '매장', address: '서울', boxes: 3, status: 'current' },
      { id: 'O3', vehicleId: 'V2', name: '매장', address: '서울', boxes: 4, status: 'pending' },
    ],
    deliveries: [], dispatchOrders: [{ id: 'O1' }, { id: 'O2' }], customerStopId: 'O2', scenarioStopId: 'O2',
    truck: { fromId: 'MFC', toId: 'O2', atStopId: null },
  };
  const data = adaptSimulation(raw);
  assert.equal(data.sourceOrders, raw.fleetDeliveries);
  assert.deepEqual(data.sourceOrders.map(order => order.id), ['O1', 'O2', 'O3']);
  assert.deepEqual(data.fleetDeliveries.map(stop => stop.orderIds), [['O1', 'O2'], ['O3']]);
  assert.deepEqual(data.deliveries.map(stop => stop.id), ['O1']);
  assert.equal(data.customerStopId, 'O1');
  assert.equal(data.scenarioStopId, 'O1');
  assert.equal(data.sourceData.defaultStopId, 'O1');
  assert.deepEqual(data.dispatchOrders, raw.dispatchOrders);
  assert.deepEqual(data.truck, { fromId: 'MFC', toId: 'O1', atStopId: null });
  assert.deepEqual(data.vehicleStates.V1.truck, { fromId: 'O1', toId: 'O1', atStopId: 'O1' });
});

test('불완전한 source 상태는 레거시 상태로 오인하지 않는다', () => {
  assert.throws(() => adaptSimulation({ sourceData: 'invalid', fleetDeliveries: [], fleetVehicles: [], vehicleStates: {} }), /배송 자료/);
});
