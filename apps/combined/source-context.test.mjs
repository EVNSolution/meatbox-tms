import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceRouteData, sourceVehicleContext } from './source-context.mjs';

const state = {
  sourceData: { date: '2025-09-12', defaultStopId: 'O2', defaultVehicleId: 'G1' },
  fleetVehicles: [{ id: 'G1', driver: '기사 1' }, { id: 'G2', driver: '기사 2' }],
  fleetDeliveries: [
    { id: 'O1', vehicleId: 'G1', coordinates: [127.1, 37.5], status: 'done' },
    { id: 'O2', vehicleId: 'G1', coordinates: [127.2, 37.6], status: 'pending' },
    { id: 'O3', vehicleId: 'G2', coordinates: [127.3, 37.7], status: 'current' },
  ],
  vehicleStates: { G1: { phase: 'delivering', kpi: { finishEta: '18:20' } } },
};

test('실제 날짜 상태에서 선택 차량만 뷰어 컨텍스트로 만들고 전체 원본 fleet은 보존한다', () => {
  const before = structuredClone(state);
  const view = sourceVehicleContext(state, 'O1');
  assert.equal(view.vehicle.id, 'G1');
  assert.deepEqual(view.deliveries.map(item => item.id), ['O1', 'O2']);
  assert.equal(view.customerStopId, 'O1');
  assert.equal(view.phase, 'delivering');
  assert.equal(view.kpi.finishEta, '18:20');
  assert.equal(view.kpi.stops, 2);
  assert.equal(view.kpi.completed, 1);
  assert.deepEqual(state, before);
});

test('배송원 지도 입력은 유효한 실제 좌표만 사용하고 도로 경로를 만들지 않는다', () => {
  const route = sourceRouteData([{ id: 'A', coordinates: [127.1, 37.5] }, { id: 'B', coordinates: null }, { id: 'C', coordinates: [127.2] }]);
  assert.deepEqual(route.points, [{ id: 'A', name: undefined, lng: 127.1, lat: 37.5 }]);
  assert.deepEqual(route.routes, []);
});

test('같은 차량의 배송지 상세를 바꿔도 예상 운행 요약은 같고 다른 차량에 섞이지 않는다', () => {
  const source = structuredClone(state);
  source.fleetDeliveries = source.fleetDeliveries.map(stop => ({ ...stop, status: 'pending' }));
  const before = structuredClone(source);
  const first = sourceVehicleContext(source, 'O1');
  const second = sourceVehicleContext(source, 'O2');
  assert.equal(first.viewerPlan.finishText, second.viewerPlan.finishText);
  assert.equal(first.deliveries[0].etaSource, 'operating-plan');
  assert.equal(first.fleetDeliveries.find(stop => stop.id === 'O3').etaSource, undefined);
  const other = sourceVehicleContext(source, 'O3');
  assert.deepEqual(other.deliveries.map(stop => stop.id), ['O3']);
  assert.equal(other.deliveries[0].etaSource, 'operating-plan');
  assert.deepEqual(source, before);
});
