import test from 'node:test';
import assert from 'node:assert/strict';
import { driverTipDelivery, driverViewModel } from './driver-view-model.mjs';

const state = dwelling => ({
  phase: 'delivering',
  truck: { dwelling, remainingM: 1830 },
  deliveries: [
    { id: 'S1', name: '문정갈비', address: '서울 송파구', boxes: 10, status: 'current' },
    { id: 'S2', name: '한우마을', address: '서울 강남구', boxes: 8, status: 'pending' },
    { id: 'S3', name: '완료매장', address: '서울 서초구', boxes: 4, status: 'done' },
    { id: 'S4', name: '보류매장', address: '서울 광진구', boxes: 6, status: 'skipped' },
  ],
  kpi: { finishEta: '09:20' },
});

test('합성 배송지를 팁 대상으로 골라도 완료 대상은 실제 운행의 현재 배송지로 유지한다', () => {
  const syntheticVehicle = { id: 'V2', plate: '예시 차량 002', driver: '예시 배송원 002', live: false, status: '배차 예시' };
  const synthetic = [1, 2, 3].map(sequence => ({ id: `V2-S${sequence}`, name: `예시 배송지 ${sequence}`, boxes: 20, status: 'pending', vehicle: syntheticVehicle }));
  const fleetState = { ...state(true), vehicle: { id: 'V1' }, fleetDeliveries: [...state(true).deliveries, ...synthetic] };
  assert.equal(driverTipDelivery(fleetState, 'V2-S1').id, 'V2-S1');
  const view = driverViewModel(fleetState, true, 'V2-S1');
  assert.equal(view.current, null);
  assert.equal(view.canComplete, false);
  assert.equal(view.vehicle.driver, '예시 배송원 002');
  assert.equal(view.deliveries.length, 3);
  assert.equal(view.remainingBoxes, 60);
  assert.equal(view.progress, '0/3');
  assert.equal(view.finishEta, '—');
});

test('배송원 완료 처리는 연결된 차량이 현재 배송지에 도착한 경우에만 열린다', () => {
  assert.equal(driverViewModel(state(false), true).canComplete, false);
  assert.equal(driverViewModel(state(true), false).canComplete, false);
  const arrived = driverViewModel(state(true), true);
  assert.equal(arrived.canComplete, true);
  assert.equal(arrived.remainingBoxes, 18);
  assert.equal(arrived.progress, '1/4');
  assert.equal(arrived.finishEta, '09:20');
  assert.equal(driverViewModel(state(false), true).distance, '1.8km');
});
