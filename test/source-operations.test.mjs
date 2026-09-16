import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceOperations } from '../lib/source-operations.mjs';

const group = (id, label = id) => ({ id, label, regionNames: ['서울'] });
const order = (id, groupId, boxes, sequence) => ({ id, groupId, orderNumber: id, name: `주문 ${id}`, address: `주소 ${id}`, detailAddress: '', boxes, sourceRows: boxes, sequence, coordinates: [127 + sequence / 1000, 37.5], zoneIds: ['Z1'] });
function day() {
  return {
    schemaVersion: 1,
    date: '2025-09-12',
    summary: { orders: 5, boxes: 15 },
    groups: [group('G1', '실제기사1'), group('G2', '실제기사2'), group('EMPTY', '빈기사')],
    orders: [order('O1', 'G1', 1, 1), order('O2', 'G1', 2, 2), order('O3', 'G1', 3, 3), order('O4', 'G2', 4, 1), order('O5', 'G2', 5, 2)],
  };
}
function bundledDay() {
  const first = { ...order('O1', 'G1', 1, 1), name: '유쾌한우정육점', address: '서울 강남구 1' };
  const sibling = {
    ...order('O1B', 'G1', 2, 2),
    name: '유쾌한우정육점'.normalize('NFD') + ' ',
    address: ' 서울 강남구 1 ',
    customerRequests: { source: 'actual', items: [{ id: 'O1B-handoff', kind: 'handoff', label: '직접 전달', required: true }] },
  };
  first.customerRequests = { source: 'actual', items: [{ id: 'O1-refrigerator', kind: 'refrigerator', label: '냉장고 보관', required: true }] };
  return {
    schemaVersion: 1,
    date: '2025-09-12',
    summary: { orders: 5, boxes: 15 },
    groups: [group('G1'), group('G2')],
    orders: [first, sibling, order('O2', 'G1', 3, 3), order('O3', 'G1', 4, 4), { ...first, id: 'O4', groupId: 'G2', sequence: 1, boxes: 5 }],
  };
}
const command = (operations, body) => operations.command({ expectedRevision: operations.snapshot().revision, ...body });

test('원본 주문과 실제 기사명을 보존한 전체 뷰어 상태를 만들며 초기 사건과 가짜 정보는 없다', () => {
  const source = day();
  const before = structuredClone(source);
  const state = createSourceOperations(source, { sourceId: 'csv-sha' }).snapshot();
  assert.deepEqual(source, before);
  assert.equal(state.sourceData.date, source.date);
  assert.equal(state.sourceData.sourceId, 'csv-sha');
  assert.equal(state.fleetVehicles.length, 3);
  assert.deepEqual(state.fleetVehicles.map(item => item.driver), ['실제기사1', '실제기사2', '빈기사']);
  assert.equal(state.fleetVehicles.every(item => item.live && item.operationsSource === 'local' && item.source === 'demo-vehicle' && item.location.source === 'demo'), true);
  assert.equal(state.fleetDeliveries.length, 5);
  assert.equal(state.fleetDeliveries.every(item => item.status === 'pending' && item.ordered && item.customerRequests === null && item.items.length === 0 && item.officialEta === null && item.calculatedEta === null), true);
  assert.deepEqual(state.fleetDeliveries[0].coordinates, source.orders[0].coordinates);
  assert.equal(state.fleetDeliveries[0].originalGroupId, 'G1');
  assert.equal(state.fleetDeliveries[0].sourceRows, 1);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.device, null);
  assert.equal(state.speed, 0);
  assert.deepEqual(state.incidents, []);
  assert.equal(state.vehicleStates.EMPTY.kpi.stopsTotal, 0);
});

test('기본 차량은 35곳 70박스에 가장 가까운 실제 그룹으로 결정한다', () => {
  const source = { schemaVersion: 1, date: '2025-09-12', summary: {}, groups: [group('A'), group('B'), group('C')], orders: [] };
  for (let index = 0; index < 35; index++) source.orders.push(order(`A${index}`, 'A', index < 3 ? 3 : 2, index)); // 73 boxes
  for (let index = 0; index < 31; index++) source.orders.push(order(`B${index}`, 'B', index < 10 ? 3 : 2, index)); // 72 boxes
  source.orders.push(order('C1', 'C', 70, 1));
  const state = createSourceOperations(source).snapshot();
  assert.equal(state.sourceData.defaultVehicleId, 'A');
  assert.equal(state.deliveries.length, 35);
  assert.equal(state.kpi.boxesTotal, 73);
});

test('배송 출발부터 도착과 사진 완료까지 한 차량에서 일관되게 진행한다', () => {
  const operations = createSourceOperations(day(), { now: () => 1234 });
  let state = command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' }).state;
  assert.equal(state.vehicleStates.G1.phase, 'delivering');
  assert.equal(state.fleetDeliveries.find(item => item.id === 'O1').status, 'current');
  assert.equal(state.fleetDeliveries.filter(item => item.status === 'done').length, 0);
  state = command(operations, { type: 'arrive_stop', vehicleId: 'G1', stopId: 'O1' }).state;
  assert.equal(state.vehicleStates.G1.truck.dwelling, true);
  assert.throws(() => command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1' }), error => error.status === 400 && /사진/.test(error.message));
  state = command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true }).state;
  assert.equal(state.fleetDeliveries.find(item => item.id === 'O1').status, 'done');
  assert.equal(state.fleetDeliveries.find(item => item.id === 'O2').status, 'current');
  assert.equal(state.vehicleStates.G1.kpi.boxesDelivered, 1);
  assert.deepEqual(state.events.map(item => [item.ts, item.stopId, item.vehicleId, item.action]), [[1234, 'O1', 'G1', 'completed'], [1234, 'O1', 'G1', 'arrived'], [1234, 'O1', 'G1', 'shipping']]);
  assert.deepEqual(state.notifications.map(item => item.kind), ['shipping', 'arrived', 'completed']);
  assert.equal(state.notifications.every(item => item.stopId === 'O1' && item.status === '기록' && item.time === '09:00' && item.clock === '09:00'), true);
  assert.equal(state.notifications.some(item => /로컬 화면/.test(item.body)), false);
  assert.equal(state.fleetDeliveries.find(item => item.id === 'O1').completedAt, '09:00');
  assert.deepEqual(state.fleetDeliveries.find(item => item.id === 'O1').timeline.map(item => item.time), ['09:00', '09:00', '09:00']);
});

test('완료 후 다음 배송지는 이전 피킹 상태 대신 이동 중 상태를 공유한다', () => {
  const operations = createSourceOperations(day());
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O2', scenario: 'picking' });
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  const { state } = command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true });
  const next = state.fleetDeliveries.find(stop => stop.id === 'O2');
  assert.equal(next.status, 'current');
  assert.equal(next.customerStatus.key, 'shipping');
  assert.equal(state.vehicleStates.G1.truck.toId, next.id);
});

test('같은 차량의 정규화된 동일 배송지는 한 번에 출발·도착·필수 요청 확인·완료하고 다음 고유 배송지로 이동한다', () => {
  const source = bundledDay();
  const before = structuredClone(source);
  const operations = createSourceOperations(source, { sourceId: 'bundle-source', now: () => 1234 });
  let changed = command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1B', scenario: 'shipping' });
  assert.deepEqual(changed.result.orderIds, ['O1', 'O1B']);
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.status), ['current', 'current']);
  assert.equal(changed.state.fleetDeliveries.find(item => item.id === 'O4').status, 'pending');

  changed = command(operations, { type: 'arrive_stop', vehicleId: 'G1', stopId: 'O1B' });
  const arrivedRevision = changed.state.revision;
  assert.throws(() => command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true, confirmedRequestIds: ['O1-refrigerator'] }), error => error.status === 400 && /필수 고객 요청/.test(error.message));
  assert.equal(operations.revision, arrivedRevision);
  assert.throws(() => command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', confirmedRequestIds: ['O1-refrigerator', 'O1B-handoff'] }), error => error.status === 400 && /사진/.test(error.message));
  assert.equal(operations.revision, arrivedRevision);

  changed = command(operations, {
    type: 'complete_stop', vehicleId: 'G1', stopId: 'O1B', hasPhoto: true,
    confirmedRequestIds: ['O1-refrigerator', 'O1B-handoff'],
  });
  assert.equal(changed.result.stopId, 'O1');
  assert.equal(changed.result.nextStopId, 'O2');
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.status), ['done', 'done']);
  assert.equal(changed.state.fleetDeliveries.find(item => item.id === 'O2').status, 'current');
  assert.equal(changed.state.vehicleStates.G1.kpi.boxesDelivered, 3);
  assert.deepEqual(changed.state.events.map(item => [item.action, item.stopId, item.orderIds]), [
    ['completed', 'O1', ['O1', 'O1B']], ['arrived', 'O1', ['O1', 'O1B']], ['shipping', 'O1', ['O1', 'O1B']],
  ]);
  assert.equal(changed.state.notifications.length, 3);
  for (const id of ['O1', 'O1B']) {
    const child = changed.state.fleetDeliveries.find(item => item.id === id);
    assert.equal(child.timeline.length, 3);
    assert.equal(child.notices.length, 3);
  }
  assert.deepEqual(source, before);

  const restored = createSourceOperations(source, { sourceId: 'bundle-source', checkpoint: operations.exportCheckpoint() }).snapshot();
  for (const id of ['O1', 'O1B']) {
    const child = restored.fleetDeliveries.find(item => item.id === id);
    assert.equal(child.status, 'done');
    assert.equal(child.timeline.length, 3);
    assert.equal(child.notices.length, 3);
  }
});

test('동일 배송지의 준비·보류·팁과 순서 편집은 묶음 단위이며 분리·현재 배송지 이동을 거부한다', () => {
  const operations = createSourceOperations(bundledDay(), { now: () => 5678 });
  let changed = command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1B', scenario: 'picking' });
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.customerStatus.key), ['picking', 'picking']);
  changed = command(operations, { type: 'toggle_skip', vehicleId: 'G1', stopId: 'O1B' });
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.status), ['skipped', 'skipped']);
  changed = command(operations, { type: 'toggle_skip', vehicleId: 'G1', stopId: 'O1' });
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.status), ['pending', 'pending']);
  changed = command(operations, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O1B', body: '  뒷문 이용  ' });
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.tip.body), ['뒷문 이용', '뒷문 이용']);

  const route = changed.state.fleetDeliveries.filter(item => item.vehicleId === 'G1');
  const routeCommand = orderIds => ({
    type: 'set_route_order', vehicleId: 'G1', order: orderIds,
    expectedOrder: route.map(item => item.id), expectedStatuses: route.map(item => item.status), expectedPhase: changed.state.vehicleStates.G1.phase,
  });
  const revision = operations.revision;
  assert.throws(() => command(operations, routeCommand(['O1', 'O2', 'O1B', 'O3'])), error => error.status === 400 && /붙어/.test(error.message));
  assert.equal(operations.revision, revision);
  changed = command(operations, routeCommand(['O2', 'O1', 'O1B', 'O3']));
  assert.deepEqual(changed.state.fleetDeliveries.filter(item => item.vehicleId === 'G1').map(item => item.id), ['O2', 'O1', 'O1B', 'O3']);

  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  const currentRoute = operations.snapshot().fleetDeliveries.filter(item => item.vehicleId === 'G1');
  assert.throws(() => command(operations, {
    type: 'set_route_order', vehicleId: 'G1', order: ['O1', 'O1B', 'O2', 'O3'],
    expectedOrder: currentRoute.map(item => item.id), expectedStatuses: currentRoute.map(item => item.status), expectedPhase: 'delivering',
  }), error => error.status === 400 && /현재/.test(error.message));
});

test('CAS와 배송 순서 기준 상태가 오래되면 변경 없이 충돌한다', () => {
  const operations = createSourceOperations(day());
  assert.throws(() => operations.command({ type: 'toggle_skip', vehicleId: 'G1', stopId: 'O1' }), error => error.status === 400);
  const first = command(operations, { type: 'toggle_skip', vehicleId: 'G1', stopId: 'O3' });
  assert.equal(first.state.revision, 1);
  assert.throws(() => operations.command({ type: 'toggle_skip', expectedRevision: 0, vehicleId: 'G1', stopId: 'O2' }), error => error.status === 409);
  const route = first.state.fleetDeliveries.filter(item => item.vehicleId === 'G1');
  assert.throws(() => command(operations, { type: 'set_route_order', vehicleId: 'G1', order: ['O2', 'O1', 'O3'], expectedOrder: route.map(item => item.id), expectedStatuses: ['pending', 'pending', 'pending'], expectedPhase: 'idle' }), error => error.status === 409);
  assert.deepEqual(operations.snapshot().fleetDeliveries.filter(item => item.vehicleId === 'G1').map(item => item.id), ['O1', 'O2', 'O3']);
});

test('배송 순서는 현재와 완료 배송지를 잠그고 대기·보류 배송지만 수정한다', () => {
  const operations = createSourceOperations(day());
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  const state = operations.snapshot();
  const route = state.fleetDeliveries.filter(item => item.vehicleId === 'G1');
  assert.throws(() => command(operations, { type: 'set_route_order', vehicleId: 'G1', order: ['O2', 'O1', 'O3'], expectedOrder: route.map(item => item.id), expectedStatuses: route.map(item => item.status), expectedPhase: 'delivering' }), error => error.status === 400);
  const changed = command(operations, { type: 'set_route_order', vehicleId: 'G1', order: ['O1', 'O3', 'O2'], expectedOrder: route.map(item => item.id), expectedStatuses: route.map(item => item.status), expectedPhase: 'delivering' }).state;
  assert.deepEqual(changed.fleetDeliveries.filter(item => item.vehicleId === 'G1').map(item => item.id), ['O1', 'O3', 'O2']);
});

test('재배정은 현재·완료 주문을 보호하고 수량·좌표를 보존하며 빈 그룹도 유지한다', () => {
  const operations = createSourceOperations(day());
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  assert.throws(() => command(operations, { type: 'reassign', orderIds: ['O2', 'O1'], targetVehicleId: 'G2' }), error => error.status === 400);
  const before = operations.snapshot();
  const moved = command(operations, { type: 'reassign', orderIds: ['O4', 'O5'], targetVehicleId: 'EMPTY' });
  assert.deepEqual(moved.result, { type: 'reassign', targetVehicleId: 'EMPTY', changedCount: 2, changedBoxes: 9, persisted: false });
  assert.equal(moved.state.vehicleStates.G2.kpi.stopsTotal, 0);
  assert.equal(moved.state.vehicleStates.EMPTY.kpi.stopsTotal, 2);
  assert.equal(moved.state.fleetDeliveries.reduce((sum, item) => sum + item.boxes, 0), before.fleetDeliveries.reduce((sum, item) => sum + item.boxes, 0));
  assert.deepEqual(moved.state.fleetDeliveries.find(item => item.id === 'O4').coordinates, before.fleetDeliveries.find(item => item.id === 'O4').coordinates);
  assert.equal(moved.state.fleetDeliveries.find(item => item.id === 'O4').originalGroupId, 'G2');
});

test('배차 관리의 targetGroupId 이름도 같은 원자적 재배정 계약을 사용한다', () => {
  const operations = createSourceOperations(day());
  assert.equal(operations.revision, 0);
  const moved = command(operations, { type: 'reassign', orderIds: ['O5'], targetGroupId: 'G1' });
  assert.equal(operations.revision, 1);
  assert.equal(moved.state.fleetDeliveries.find(item => item.id === 'O5').vehicleId, 'G1');
});

test('배송 팁과 고객 안내는 해당 원본 주문에만 실제 로컬 사건으로 기록한다', () => {
  const operations = createSourceOperations(day(), { now: () => 5678 });
  command(operations, { type: 'set_delivery_tip', vehicleId: 'G2', stopId: 'O4', body: '  경비실에 문의  ' });
  const sent = command(operations, { type: 'send_customer_notice', vehicleId: 'G2', stopId: 'O4', body: '곧 도착합니다.', author: '배차 관리자' });
  const order = sent.state.fleetDeliveries.find(item => item.id === 'O4');
  assert.equal(order.tip.body, '경비실에 문의');
  assert.equal(order.notices[0].status, '기록');
  assert.equal(order.notices[0].ts, 5678);
  assert.equal(sent.state.fleetDeliveries.filter(item => item.notices.length).length, 1);
  assert.deepEqual(sent.state.events.map(item => item.stopId), ['O4', 'O4']);
});

test('잘못된 차량·배송지·요청 확인과 무변경 명령은 revision을 올리지 않는다', () => {
  const operations = createSourceOperations(day());
  for (const body of [
    { type: 'toggle_skip', vehicleId: 'BAD', stopId: 'O1' },
    { type: 'toggle_skip', vehicleId: 'G1', stopId: 'BAD' },
    { type: 'send_customer_notice', vehicleId: 'G1', stopId: 'O1', body: '<b>안내</b>' },
    { type: 'reset' },
  ]) assert.throws(() => command(operations, body), error => error.status === 400);
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  assert.throws(() => command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true, confirmedRequestIds: ['fake-request'] }), error => error.status === 400);
  assert.equal(operations.snapshot().revision, 1);
});

test('원본 주문은 completed 장면으로 우회 완료할 수 없고 완료 후 상태도 바꿀 수 없다', () => {
  const operations = createSourceOperations(day(), { now: () => 1234 });
  assert.throws(() => command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'completed' }), error => error.status === 400 && /배송 완료 버튼/.test(error.message));
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true });
  const revision = operations.revision;
  assert.throws(() => command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'picking' }), error => error.status === 400 && /완료된 배송지/.test(error.message));
  assert.equal(operations.revision, revision);
  assert.equal(operations.snapshot().fleetDeliveries.find(item => item.id === 'O1').status, 'done');
});

test('잘못된 원본 날짜는 상태 생성 전에 400으로 거부한다', () => {
  for (const date of ['2025-02-30', '2025-99-12', '../2025-09-12']) {
    assert.throws(() => createSourceOperations({ ...day(), date }), error => error.status === 400 && /날짜/.test(error.message));
  }
});

test('초기화는 배정·진행·팁·알림을 원본 상태로 되돌리고 원본 객체는 변경하지 않는다', () => {
  const source = day();
  const before = structuredClone(source);
  const operations = createSourceOperations(source);
  command(operations, { type: 'reassign', orderIds: ['O5'], targetVehicleId: 'G1' });
  command(operations, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O2', body: '테스트 팁' });
  command(operations, { type: 'send_customer_notice', vehicleId: 'G1', stopId: 'O2', body: '테스트 안내' });
  const reset = command(operations, { type: 'reset' });
  assert.deepEqual(source, before);
  assert.deepEqual(reset.state.fleetDeliveries.map(item => [item.id, item.vehicleId, item.status, item.tip]), [
    ['O1', 'G1', 'pending', null], ['O2', 'G1', 'pending', null], ['O3', 'G1', 'pending', null], ['O4', 'G2', 'pending', null], ['O5', 'G2', 'pending', null],
  ]);
  assert.deepEqual(reset.state.notifications, []);
  assert.deepEqual(reset.state.events, []);
});

test('작은 체크포인트는 원본 필드를 복제하지 않고 모든 변경과 CAS revision을 정확히 복원한다', () => {
  const source = day();
  const operations = createSourceOperations(source, { sourceId: 'csv-sha', now: () => 1234 });
  command(operations, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O2', body: '경비실 문의' });
  command(operations, { type: 'send_customer_notice', vehicleId: 'G1', stopId: 'O2', body: '곧 도착합니다.' });
  command(operations, { type: 'reassign', orderIds: ['O5'], targetGroupId: 'G1' });
  command(operations, { type: 'toggle_skip', vehicleId: 'G2', stopId: 'O4' });
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true });
  const checkpoint = operations.exportCheckpoint();
  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(serialized, /주소 O|주문 O|orderNumber|detailAddress/);
  assert.ok(Object.keys(checkpoint.orders).length < source.orders.length);
  assert.ok(Object.keys(checkpoint.routes).length < source.groups.length);

  const restored = createSourceOperations(source, { sourceId: 'csv-sha', now: () => 9999, checkpoint });
  assert.equal(restored.revision, operations.revision);
  assert.deepEqual(restored.snapshot(), operations.snapshot());
  assert.throws(() => restored.command({ type: 'reset', expectedRevision: restored.revision - 1 }), error => error.status === 409);
  assert.equal(command(restored, { type: 'reset' }).state.revision, operations.revision + 1);
});

test('레거시 체크포인트의 비대표 현재 주문을 물리 배송지 상태와 대표 참조로 정규화한다', () => {
  const source = bundledDay();
  const original = createSourceOperations(source, { sourceId: 'legacy-current', now: () => 1234 });
  command(original, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1B', scenario: 'shipping' });
  const checkpoint = original.exportCheckpoint();
  delete checkpoint.orders.O1;
  checkpoint.states.G1.scenarioStopId = 'O1B';
  checkpoint.states.G1.truck.toId = 'O1B';
  checkpoint.events[0].stopId = 'O1B';
  delete checkpoint.events[0].orderIds;
  checkpoint.notices[0].stopId = 'O1B';
  delete checkpoint.notices[0].orderIds;
  const before = structuredClone(checkpoint);

  const restored = createSourceOperations(source, { sourceId: 'legacy-current', now: () => 5678, checkpoint });
  assert.deepEqual(checkpoint, before);
  let state = restored.snapshot();
  assert.deepEqual(state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => [item.status, item.customerStatus.key]), [
    ['current', 'shipping'], ['current', 'shipping'],
  ]);
  assert.equal(state.vehicleStates.G1.phase, 'delivering');
  assert.equal(state.vehicleStates.G1.scenarioStopId, 'O1');
  assert.equal(state.vehicleStates.G1.truck.toId, 'O1');
  for (const id of ['O1', 'O1B']) {
    const child = state.fleetDeliveries.find(item => item.id === id);
    assert.equal(child.timeline.length, 1);
    assert.equal(child.notices.length, 1);
  }

  state = command(restored, { type: 'arrive_stop', vehicleId: 'G1', stopId: 'O1B' }).state;
  assert.deepEqual(state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => item.customerStatus.key), ['arrived', 'arrived']);
  const migrated = restored.exportCheckpoint();
  assert.deepEqual(createSourceOperations(source, { sourceId: 'legacy-current', checkpoint: migrated }).snapshot(), restored.snapshot());
});

test('레거시 완료 자식은 전체 배송지를 완료로 보호하고 차량 참조를 대표 주문으로 복원한다', () => {
  const source = bundledDay();
  const original = createSourceOperations(source, { sourceId: 'legacy-done', now: () => 1234 });
  command(original, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1B', scenario: 'arrived' });
  command(original, {
    type: 'complete_stop', vehicleId: 'G1', stopId: 'O1B', hasPhoto: true,
    confirmedRequestIds: ['O1-refrigerator', 'O1B-handoff'],
  });
  const checkpoint = original.exportCheckpoint();
  delete checkpoint.orders.O1;
  checkpoint.states.G1.scenarioStopId = 'O1B';
  checkpoint.states.G1.truck.fromId = 'O1B';
  for (const event of checkpoint.events.filter(item => item.orderIds?.includes('O1B'))) {
    event.stopId = 'O1B';
    delete event.orderIds;
  }
  for (const notice of checkpoint.notices.filter(item => item.orderIds?.includes('O1B'))) {
    notice.stopId = 'O1B';
    delete notice.orderIds;
  }

  const restored = createSourceOperations(source, { sourceId: 'legacy-done', checkpoint });
  const state = restored.snapshot();
  assert.deepEqual(state.fleetDeliveries.filter(item => ['O1', 'O1B'].includes(item.id)).map(item => [item.status, item.customerStatus.key]), [
    ['done', 'delivered'], ['done', 'delivered'],
  ]);
  assert.equal(state.vehicleStates.G1.scenarioStopId, 'O1');
  assert.equal(state.vehicleStates.G1.truck.fromId, 'O1');
  for (const id of ['O1', 'O1B']) {
    const child = state.fleetDeliveries.find(item => item.id === id);
    assert.equal(child.timeline.length, 2);
    assert.equal(child.notices.length, 2);
  }
  assert.throws(() => command(restored, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O1B', body: '변경 금지' }), error => error.status === 400 && /완료/.test(error.message));
});

test('체크포인트 이력의 orderIds가 다른 차량이나 배송지를 섞으면 복원하지 않는다', () => {
  const source = bundledDay();
  const original = createSourceOperations(source, { sourceId: 'corrupt-membership' });
  command(original, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  const checkpoint = original.exportCheckpoint();
  const wrongDestination = structuredClone(checkpoint);
  wrongDestination.events[0].orderIds = ['O1', 'O2'];
  const wrongVehicle = structuredClone(checkpoint);
  wrongVehicle.notices[0].orderIds = ['O1', 'O4'];
  for (const changed of [wrongDestination, wrongVehicle]) {
    assert.throws(() => createSourceOperations(source, { sourceId: 'corrupt-membership', checkpoint: changed }), error => error.status === 400);
  }
});

test('다른 날짜·자료나 손상된 체크포인트는 복원하지 않는다', () => {
  const source = day();
  const original = createSourceOperations(source, { sourceId: 'csv-a' });
  command(original, { type: 'toggle_skip', vehicleId: 'G1', stopId: 'O3' });
  const checkpoint = original.exportCheckpoint();
  for (const changed of [
    { ...checkpoint, date: '2025-09-13' },
    { ...checkpoint, sourceId: 'csv-b' },
    { ...checkpoint, revision: -1 },
    { ...checkpoint, routes: { G1: ['O1'] } },
    { ...checkpoint, orders: { BAD: { status: 'done' } } },
  ]) assert.throws(() => createSourceOperations(source, { sourceId: 'csv-a', checkpoint: changed }), error => error.status === 400);
});
