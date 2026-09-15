import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionProofCanSubmit,
  completionProofIsCurrent,
  completionProofShouldClose,
  driverCanArrive,
  driverCanStart,
  driverConfirmedVehicles,
  driverHasConfirmedDispatch,
  driverMapDelivery,
  driverTipDelivery,
  driverViewModel,
  reconcileDriverRoute,
} from './driver-view-model.mjs';

const state = dwelling => ({
  phase: 'delivering',
  truck: { dwelling, remainingM: 1830 },
  vehicle: { id: 'V1' },
  deliveries: [
    { id: 'S1', vehicleId: 'V1', name: '문정갈비', address: '서울 송파구', boxes: 10, status: 'current', customerRequests: { source: 'example', items: [{ id: 'S1-refrigerator', kind: 'refrigerator', label: '매장 냉장고 안에 보관', required: true }] } },
    { id: 'S2', vehicleId: 'V1', name: '한우마을', address: '서울 강남구', boxes: 8, status: 'pending' },
    { id: 'S3', vehicleId: 'V1', name: '완료매장', address: '서울 서초구', boxes: 4, status: 'done' },
    { id: 'S4', vehicleId: 'V1', name: '보류매장', address: '서울 광진구', boxes: 6, status: 'skipped' },
  ],
  kpi: { finishEta: '09:20' },
});

test('차량 정보가 불완전한 외부 배송지는 V1 완료 문맥으로 열리지 않는다', () => {
  const foreign = { id: 'V2-S1', vehicleId: 'V2', name: '외부 예시 배송지', boxes: 12, status: 'current' };
  const fleetState = { ...state(true), fleetDeliveries: [...state(true).deliveries, foreign] };
  const view = driverViewModel(fleetState, true, foreign.id);
  assert.equal(view.vehicle.id, 'V2');
  assert.equal(view.current, null);
  assert.equal(view.canComplete, false);
  assert.deepEqual(view.deliveries, [foreign]);
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
  assert.deepEqual(arrived.todayCounts, { active: 2, done: 1, skipped: 1 });
  assert.equal(arrived.finishEta, '09:20');
  assert.equal(driverViewModel(state(false), true).distance, '1.8km');
});

test('배차 완료 경계가 바뀌어도 금일 배차 선택을 근무 이력으로 바꾸지 않는다', () => {
  assert.deepEqual(reconcileDriverRoute(null, false, null), { changed: false, completed: false, group: 'today' });
  assert.deepEqual(reconcileDriverRoute(false, false, 'history'), { changed: false, completed: false, group: 'history' });
  assert.deepEqual(reconcileDriverRoute(false, true, 'today'), { changed: true, completed: true, group: 'today' });
  assert.deepEqual(reconcileDriverRoute(true, false, 'history'), { changed: true, completed: false, group: 'history' });
});

test('보류된 지도 선택은 현재 운행 중인 유효 배송지로 바꾼다', () => {
  const deliveries = state(false).deliveries;
  assert.equal(driverMapDelivery(deliveries, 'S2').id, 'S2');
  assert.equal(driverMapDelivery(deliveries, 'S4').id, 'S1');
  assert.equal(driverMapDelivery(deliveries.map(stop => ({ ...stop, status: 'skipped' })), 'S4'), null);
});

test('완료 시트는 같은 배송지의 도착 상태가 유지될 때만 유효하다', () => {
  assert.equal(completionProofIsCurrent(state(true), 'S1'), true);
  assert.equal(completionProofIsCurrent(state(true), 'S2'), false);
  assert.equal(completionProofIsCurrent(state(false), 'S1'), false);
});

test('배송 완료 확인은 현재 도착 상태, 연결, 사진과 필수 고객 요청 확인이 모두 있어야 가능하다', () => {
  assert.equal(completionProofCanSubmit(state(true), true, 'S1', true, ['S1-refrigerator']), true);
  assert.equal(completionProofCanSubmit(state(true), true, 'S1', true), false);
  assert.equal(completionProofCanSubmit(state(true), true, 'S1', false), false);
  assert.equal(completionProofCanSubmit(state(true), false, 'S1', true), false);
  assert.equal(completionProofCanSubmit(state(true), true, 'S2', true), false);
});

test('요청이 없으면 사진만으로 완료 가능하고 현재 요청 ID가 바뀌면 이전 확인은 무효다', () => {
  const noRequest = state(true);
  noRequest.deliveries[0].customerRequests = { source: 'example', items: [] };
  assert.equal(completionProofCanSubmit(noRequest, true, 'S1', true), true);
  const multiple = state(true);
  multiple.deliveries[0].customerRequests.items.push({ id: 'S1-handoff', kind: 'handoff', label: '직접 전달', required: true });
  assert.equal(completionProofCanSubmit(multiple, true, 'S1', true, ['S1-refrigerator']), false);
  assert.equal(completionProofCanSubmit(multiple, true, 'S1', true, ['S1-refrigerator', 'S1-handoff']), true);
  const changed = state(true);
  changed.deliveries[0].customerRequests.items[0].id = 'S1-new-request';
  assert.equal(completionProofCanSubmit(changed, true, 'S1', true, ['S1-refrigerator']), false);
});

test('도착 상태가 유지돼도 연결이 끊기면 증빙 시트를 닫고 새 사진을 요구한다', () => {
  assert.equal(completionProofShouldClose(state(true), true, 'S1'), false);
  assert.equal(completionProofShouldClose(state(true), false, 'S1'), true);
  assert.equal(completionProofShouldClose(state(false), true, 'S1'), true);
});

test('확정 배차와 수정 중 확정본은 배송원이 운행할 수 있고 후보 차량은 선택 목록에서 제외한다', () => {
  const source = {
    ...state(false),
    sourceData: { date: '2026-09-16' },
    dispatch: { phase: 'published' },
    phase: 'idle',
    vehicle: { id: 'V1', live: true },
    fleetVehicles: [{ id: 'V1', live: true }, { id: 'V2', live: true }, { id: 'V3', live: true }],
    fleetDeliveries: [
      ...state(false).deliveries,
      { id: 'V2-S1', vehicleId: 'V2', status: 'pending' },
    ],
  };
  assert.equal(driverHasConfirmedDispatch(source), true);
  assert.equal(driverCanStart(source), true);
  assert.deepEqual(driverConfirmedVehicles(source).map(vehicle => vehicle.id), ['V1', 'V2']);
  assert.equal(driverHasConfirmedDispatch({ ...source, dispatch: { phase: 'amending' } }), true);
  assert.equal(driverCanStart({ ...source, dispatch: { phase: 'amending' } }), true);
  assert.equal(driverHasConfirmedDispatch({ ...source, dispatch: { phase: 'draft' } }), false);
  assert.equal(driverCanStart({ ...source, dispatch: { phase: 'draft' } }), false);
});

test('원본 자료 확정 직후 idle에서는 시작할 수 있지만 기존 시뮬레이션은 preparing 규칙을 유지한다', () => {
  const source = {
    ...state(false), sourceData: { date: '2026-09-16' }, dispatch: { phase: 'published' }, phase: 'idle',
    vehicle: { id: 'V1', live: true }, fleetDeliveries: state(false).deliveries,
  };
  assert.equal(driverCanStart(source), true);
  assert.equal(driverCanStart({ ...source, phase: 'preparing' }), true);
  assert.equal(driverCanStart({ ...source, phase: 'delivering' }), false);
  assert.equal(driverCanStart({ ...source, vehicle: { id: 'V1', live: false } }), false);
  assert.equal(driverCanStart({ ...state(false), phase: 'idle' }), false);
  assert.equal(driverCanStart({ ...state(false), phase: 'preparing' }), true);
});

test('원본 자료의 현재 배송지는 이동 중일 때만 도착 처리할 수 있다', () => {
  const traveling = {
    ...state(false), sourceData: { date: '2026-09-16' }, dispatch: { phase: 'published' },
    fleetDeliveries: state(false).deliveries, truck: { ...state(false).truck, toId: 'S1', dwelling: false },
  };
  assert.equal(driverCanArrive(traveling), true);
  assert.equal(driverCanArrive({ ...traveling, truck: { ...traveling.truck, dwelling: true } }), false);
  assert.equal(driverCanArrive({ ...traveling, truck: { ...traveling.truck, toId: 'S2' } }), false);
  assert.equal(driverCanArrive(traveling, false), false);
  assert.equal(driverCanArrive({ ...traveling, sourceData: null }), false);
});
