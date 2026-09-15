import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchOperations } from '../lib/dispatch-operations.mjs';
import { createSourceOperations } from '../lib/source-operations.mjs';

const group = (id, label) => ({ id, label, regionNames: ['서울'] });
const order = (id, groupId, boxes, sequence, name, address) => ({
  id, groupId, orderNumber: id, name, address, detailAddress: '', boxes, sourceRows: boxes, sequence,
  coordinates: [127 + sequence / 1000, 37.5], zoneIds: ['Z1'],
});

function day(date = '2026-09-16') {
  return {
    schemaVersion: 1,
    date,
    summary: { orders: 4, boxes: 10 },
    groups: [group('G1', '김기사'), group('G2', '박기사'), group('G3', '이기사')],
    orders: [
      order('O1', 'G1', 1, 1, '한우상회', '서울 강남구 1'),
      order('O2', 'G2', 2, 2, ' 한우상회 ', '서울 강남구 1'),
      order('O3', 'G1', 3, 3, '정육식당', '서울 송파구 2'),
      order('O4', 'G2', 4, 4, '미트마켓', '인천 남동구 3'),
    ],
  };
}

const command = (operations, body) => operations.command({ expectedRevision: operations.revision, ...body });
const calculator = ({ orders }) => Object.fromEntries(orders.map(order => [order.id, order.id === 'O4' ? 'G2' : 'G1']));
const confirmedRequests = (operations, orderIds) => [...new Set(operations.snapshot().fleetDeliveries
  .filter(order => orderIds.includes(order.id))
  .flatMap(order => order.customerRequests?.items || [])
  .filter(request => request.required)
  .map(request => request.id))];

test('오늘과 미래 주문은 초기 미배차로 보이고 원본 기사 그룹은 후보로만 보존한다', () => {
  const source = day();
  const before = structuredClone(source);
  const today = createDispatchOperations(source, { sourceId: 'csv-a', operatingDate: '2026-09-16' }).snapshot();
  assert.deepEqual(source, before);
  assert.equal(today.dispatch.phase, 'unplanned');
  assert.equal(today.dispatch.today, '2026-09-16');
  assert.equal(today.dispatch.readOnly, false);
  assert.deepEqual(today.dispatch.summary, { orders: 4, destinations: 3, boxes: 10 });
  assert.equal(today.fleetDeliveries.length, 0);
  assert.deepEqual(today.dispatchPreview, []);
  assert.equal(today.dispatchOrders.every(item => item.vehicleId === null), true);
  assert.equal(today.dispatchOrders[0].assignmentUnitId, today.dispatchOrders[1].assignmentUnitId);
  assert.notEqual(today.dispatchOrders[0].assignmentUnitId, today.dispatchOrders[2].assignmentUnitId);
  assert.deepEqual(today.dispatchOrders.map(item => item.candidateGroupId), ['G1', 'G2', 'G1', 'G2']);
  assert.deepEqual(today.dispatchCandidates.map(item => [item.id, item.driver, item.locked]), [['G1', '김기사', false], ['G2', '박기사', false], ['G3', '이기사', false]]);
  const future = createDispatchOperations(day('2026-09-17'), { operatingDate: '2026-09-16' }).snapshot();
  assert.equal(future.dispatch.readOnly, false);
  assert.equal(future.dispatch.today, '2026-09-16');
});

test('계산기는 전체 배정을 원자적으로 검증하고 기준이 없거나 배송지를 나누면 상태를 바꾸지 않는다', () => {
  const unavailable = createDispatchOperations(day(), { operatingDate: '2026-09-16' });
  assert.throws(() => command(unavailable, { type: 'calculate_dispatch', vehicleIds: ['G1'] }), error => error.status === 409 && error.code === 'CALCULATION_UNAVAILABLE');
  assert.equal(unavailable.revision, 0);

  const split = createDispatchOperations(day(), {
    operatingDate: '2026-09-16',
    calculator: () => ({ O1: 'G1', O2: 'G2', O3: 'G1', O4: 'G2' }),
  });
  assert.throws(() => command(split, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] }), error => error.status === 400 && error.code === 'DESTINATION_SPLIT');
  assert.equal(split.revision, 0);
  assert.equal(split.snapshot().dispatch.phase, 'unplanned');

  const incomplete = createDispatchOperations(day(), { operatingDate: '2026-09-16', calculator: () => ({ O1: 'G1' }) });
  assert.throws(() => command(incomplete, { type: 'calculate_dispatch', vehicleIds: ['G1'] }), error => error.code === 'INVALID_ASSIGNMENT');
  assert.equal(incomplete.revision, 0);
});

test('계산 초안은 실제 합계를 보여주지만 확정 전 배송원 운행에는 노출하지 않는다', () => {
  let received;
  const operations = createDispatchOperations(day(), {
    sourceId: 'csv-a', operatingDate: '2026-09-16', calculator(input) { received = input; return calculator(input); },
  });
  const calculated = command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  assert.equal(calculated.state.dispatch.phase, 'draft');
  assert.equal(calculated.state.dispatch.draftVersion, 1);
  assert.deepEqual(calculated.state.dispatch.candidateIds, ['G1', 'G2']);
  assert.equal(calculated.state.fleetDeliveries.length, 0);
  assert.deepEqual(calculated.state.dispatchPreview.map(item => [item.vehicleId, item.orders, item.destinations, item.boxes]), [
    ['G1', 3, 2, 6], ['G2', 1, 1, 4],
  ]);
  assert.equal(received.orders.length, 4);
  assert.equal(received.vehicles.length, 3);
  assert.deepEqual(received.vehicleIds, ['G1', 'G2']);
  assert.equal(received.units.length, 3);
  received.orders[0].name = '변조';
  assert.equal(operations.snapshot().dispatchOrders[0].name, '한우상회');
});

test('핀 재배차는 같은 이름과 주소의 주문을 함께 옮기고 확장된 주문 ID를 반환한다', () => {
  const operations = createDispatchOperations(day(), { operatingDate: '2026-09-16', calculator });
  command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  assert.throws(() => command(operations, { type: 'reassign', orderIds: ['O1'], targetVehicleId: 'G3' }), error => error.code === 'INVALID_CANDIDATE');
  assert.equal(operations.revision, 1);
  const moved = command(operations, { type: 'reassign', orderIds: ['O1'], targetGroupId: 'G2' });
  assert.deepEqual(moved.result.requestedOrderIds, ['O1']);
  assert.deepEqual(moved.result.expandedOrderIds, ['O1', 'O2']);
  assert.equal(moved.result.changedCount, 2);
  assert.equal(moved.result.changedBoxes, 3);
  assert.equal(moved.state.dispatchOrders.find(item => item.id === 'O1').vehicleId, 'G2');
  assert.equal(moved.state.dispatchOrders.find(item => item.id === 'O2').vehicleId, 'G2');
  assert.equal(moved.state.dispatch.draftVersion, 2);
});

test('최신 초안만 원자적으로 전송하고 이후에만 운행 명령을 허용한다', () => {
  let tick = 1000;
  const operations = createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, now: () => ++tick });
  assert.throws(() => command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' }), error => error.code === 'DISPATCH_NOT_PUBLISHED');
  command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  assert.throws(() => command(operations, { type: 'publish_dispatch', draftVersion: 0 }), error => error.status === 409 && error.code === 'DRAFT_CONFLICT');
  assert.equal(operations.revision, 1);
  const published = command(operations, { type: 'publish_dispatch', draftVersion: 1 });
  assert.equal(published.state.dispatch.phase, 'published');
  assert.equal(published.state.dispatch.confirmedVersion, 1);
  assert.equal(published.state.fleetDeliveries.length, 4);
  assert.equal(published.state.fleetDeliveries.every(item => typeof item.assignmentUnitId === 'string'), true);
  assert.deepEqual(published.state.dispatchPreview.map(item => item.vehicleId), ['G1', 'G2']);
  assert.deepEqual(published.state.fleetDeliveries.filter(item => item.vehicleId === 'G1').map(item => item.id), ['O1', 'O2', 'O3']);
  assert.equal(published.state.events.length, 0);
  const shipping = command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  assert.equal(shipping.state.fleetDeliveries.find(item => item.id === 'O1').status, 'current');
  assert.throws(() => command(operations, { type: 'reassign', orderIds: ['O4'], targetVehicleId: 'G1' }), error => error.code === 'DISPATCH_ALREADY_PUBLISHED');
  assert.throws(() => command(operations, { type: 'reset' }), error => error.code === 'RESET_BLOCKED');
});

test('확정 경로는 같은 배송지 주문을 붙이고 실제 배정 경로에서 기본 차량과 배송지를 고른다', () => {
  const source = day();
  source.orders.find(item => item.id === 'O2').sequence = 3;
  source.orders.find(item => item.id === 'O3').sequence = 2;
  const operations = createDispatchOperations(source, { operatingDate: '2026-09-16', calculator });
  command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  const state = command(operations, { type: 'publish_dispatch', draftVersion: 1 }).state;
  const route = state.fleetDeliveries.filter(item => item.vehicleId === 'G1');
  assert.deepEqual(route.map(item => item.id), ['O1', 'O2', 'O3']);
  assert.equal(state.sourceData.defaultVehicleId, 'G1');
  assert.equal(state.sourceData.defaultStopId, 'O1');
  assert.equal(state.vehicle.id, 'G1');
  assert.deepEqual(state.deliveries.map(item => item.id), ['O1', 'O2', 'O3']);
  assert.throws(() => command(operations, {
    type: 'set_route_order', vehicleId: 'G1', order: ['O1', 'O3', 'O2'],
    expectedOrder: route.map(item => item.id), expectedStatuses: route.map(item => item.status), expectedPhase: 'idle',
  }), error => error.status === 400 && error.code === 'DESTINATION_SPLIT');
  assert.equal(operations.revision, 2);
});

test('외부 CAS revision은 초안 횟수와 내부 운행 revision을 분리해 계속 증가한다', () => {
  const operations = createDispatchOperations(day(), { operatingDate: '2026-09-16', calculator });
  command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  command(operations, { type: 'reassign', orderIds: ['O4'], targetVehicleId: 'G1' });
  command(operations, { type: 'publish_dispatch', draftVersion: 2 });
  assert.equal(operations.revision, 3);
  const stale = { type: 'set_delivery_tip', expectedRevision: 2, vehicleId: 'G1', stopId: 'O3', body: '경비실 문의' };
  assert.throws(() => operations.command(stale), error => error.status === 409 && error.code === 'REVISION_CONFLICT');
  const changed = command(operations, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O3', body: '경비실 문의' });
  assert.equal(changed.state.revision, 4);
});

test('과거 날짜는 초안과 운행 명령을 모두 거부하고 원본만 조회한다', () => {
  const operations = createDispatchOperations(day('2026-09-15'), { operatingDate: '2026-09-16', calculator });
  const state = operations.snapshot();
  assert.equal(state.dispatch.readOnly, true);
  assert.equal(state.dispatch.today, '2026-09-16');
  assert.equal(state.dispatch.canCalculate, false);
  assert.equal(state.fleetDeliveries.length, 0);
  assert.equal(state.dispatchOrders.length, 4);
  assert.equal(state.dispatchCandidates.every(item => item.locked), true);
  for (const body of [
    { type: 'calculate_dispatch', vehicleIds: ['G1'] },
    { type: 'reassign', orderIds: ['O1'], targetVehicleId: 'G1' },
    { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' },
  ]) assert.throws(() => command(operations, body), error => error.status === 409 && error.code === 'DATE_READ_ONLY');
  assert.equal(operations.revision, 0);
});

test('v2 초안과 확정 운행 체크포인트는 원본 전문 없이 revision과 상태를 복원한다', () => {
  const source = day();
  const draft = createDispatchOperations(source, { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, now: () => 1234 });
  command(draft, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  command(draft, { type: 'reassign', orderIds: ['O4'], targetVehicleId: 'G1' });
  const draftCheckpoint = draft.exportCheckpoint();
  assert.equal(draftCheckpoint.schemaVersion, 2);
  assert.doesNotMatch(JSON.stringify(draftCheckpoint), /한우상회|서울 강남구|orderNumber/);
  const restoredDraft = createDispatchOperations(source, { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, now: () => 9999, checkpoint: draftCheckpoint });
  assert.deepEqual(restoredDraft.snapshot(), draft.snapshot());

  command(restoredDraft, { type: 'publish_dispatch', draftVersion: 2 });
  command(restoredDraft, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  const publishedCheckpoint = restoredDraft.exportCheckpoint();
  const restoredPublished = createDispatchOperations(source, { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, checkpoint: publishedCheckpoint });
  assert.deepEqual(restoredPublished.snapshot(), restoredDraft.snapshot());
  assert.equal(restoredPublished.revision, restoredDraft.revision);

  for (const changed of [
    { ...draftCheckpoint, sourceId: 'csv-b' },
    { ...draftCheckpoint, operatingDate: '2026-09-17' },
    { ...draftCheckpoint, candidateIds: ['BAD'] },
    { ...draftCheckpoint, draftAssignments: { ...draftCheckpoint.draftAssignments, O1: 'G2' } },
  ]) assert.throws(() => createDispatchOperations(source, { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, checkpoint: changed }), error => error.status === 400);
});

test('변경 이력이 있는 기존 운행 체크포인트는 확정 배차로 보존하고 과거에는 조회만 허용한다', () => {
  const source = day('2026-09-15');
  const legacy = createSourceOperations(source, { sourceId: 'csv-a', now: () => 1234 });
  legacy.command({ type: 'set_scenario', expectedRevision: 0, vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  const operations = createDispatchOperations(source, {
    sourceId: 'csv-a', operatingDate: '2026-09-16', checkpoint: legacy.exportCheckpoint(),
  });
  const state = operations.snapshot();
  assert.equal(state.dispatch.phase, 'published');
  assert.equal(state.dispatch.readOnly, true);
  assert.equal(state.fleetDeliveries.length, 4);
  assert.equal(state.fleetDeliveries.find(item => item.id === 'O1').status, 'current');
  assert.equal(state.revision, 1);
  assert.throws(() => command(operations, { type: 'set_delivery_tip', vehicleId: 'G1', stopId: 'O1', body: '변경' }), error => error.code === 'DATE_READ_ONLY');
  const migrated = createDispatchOperations(source, {
    sourceId: 'csv-a', operatingDate: '2026-09-16', checkpoint: operations.exportCheckpoint(),
  });
  assert.deepEqual(migrated.snapshot(), state);

  const emptyLegacy = createSourceOperations(day(), { sourceId: 'csv-a' }).exportCheckpoint();
  assert.throws(() => createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', checkpoint: emptyLegacy }), error => error.code === 'INVALID_CHECKPOINT');
});

test('중복 주문 ID와 배송지 식별 필드가 없는 원본은 상태 생성 전에 거부한다', () => {
  const duplicate = day();
  duplicate.orders.push({ ...duplicate.orders[0] });
  assert.throws(() => createDispatchOperations(duplicate, { operatingDate: '2026-09-16' }), error => error.status === 400 && error.code === 'INVALID_DAY');
  const missingAddress = day();
  delete missingAddress.orders[0].address;
  assert.throws(() => createDispatchOperations(missingAddress, { operatingDate: '2026-09-16' }), error => error.status === 400 && error.code === 'INVALID_DAY');
});

function publishedOperations() {
  const operations = createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator });
  command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1', 'G2'] });
  command(operations, { type: 'publish_dispatch', draftVersion: 1 });
  return operations;
}

test('수정안은 기존 운행과 분리되며 다시 전송할 때만 배정이 바뀌고 기록을 보존한다', () => {
  const operations = publishedOperations();
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'arrived' });
  command(operations, { type: 'complete_stop', vehicleId: 'G1', stopId: 'O1', hasPhoto: true, confirmedRequestIds: confirmedRequests(operations, ['O1', 'O2']) });
  command(operations, { type: 'set_delivery_tip', vehicleId: 'G2', stopId: 'O4', body: '출입문 옆' });
  const confirmed = operations.snapshot();
  const started = command(operations, { type: 'begin_dispatch_revision' });
  assert.equal(started.state.dispatch.phase, 'amending');
  assert.equal(started.state.dispatch.canPublish, false);
  assert.throws(() => command(operations, { type: 'publish_dispatch', draftVersion: 2 }), error => error.code === 'NO_ASSIGNMENT_CHANGE');
  assert.throws(() => command(operations, { type: 'calculate_dispatch', vehicleIds: ['G1'] }), error => error.code === 'DISPATCH_ALREADY_PUBLISHED');
  command(operations, { type: 'reassign', orderIds: ['O4'], targetVehicleId: 'G1' });
  const draft = operations.snapshot();
  assert.equal(draft.dispatch.hasChanges, true);
  assert.equal(draft.dispatchOrders.find(order => order.id === 'O4').vehicleId, 'G1');
  assert.deepEqual(draft.fleetDeliveries, confirmed.fleetDeliveries);
  assert.deepEqual(draft.events, confirmed.events);
  assert.deepEqual(draft.notifications, confirmed.notifications);
  const published = command(operations, { type: 'publish_dispatch', draftVersion: draft.dispatch.draftVersion });
  assert.equal(published.result.amended, true);
  assert.equal(published.state.fleetDeliveries.find(order => order.id === 'O4').vehicleId, 'G1');
  assert.deepEqual(published.state.fleetDeliveries.find(order => order.id === 'O4').tip, confirmed.fleetDeliveries.find(order => order.id === 'O4').tip);
  for (const id of ['O1', 'O2']) assert.deepEqual(published.state.fleetDeliveries.find(order => order.id === id), confirmed.fleetDeliveries.find(order => order.id === id));
  assert.deepEqual(published.state.events.filter(event => confirmed.events.some(previous => previous.id === event.id)), confirmed.events);
  assert.deepEqual(published.state.notifications, confirmed.notifications);
});

test('현재와 완료 주문이 있는 배송지 묶음은 나머지 주문까지 보호한다', () => {
  const operations = publishedOperations();
  command(operations, { type: 'set_scenario', vehicleId: 'G1', stopId: 'O1', scenario: 'shipping' });
  command(operations, { type: 'begin_dispatch_revision' });
  assert.equal(operations.snapshot().dispatchOrders.find(order => order.id === 'O2').assignmentProtected, true);
  const before = operations.exportCheckpoint();
  assert.throws(() => command(operations, { type: 'reassign', orderIds: ['O2'], targetVehicleId: 'G2' }), error => error.code === 'PROTECTED_DESTINATION');
  assert.deepEqual(operations.exportCheckpoint(), before);
});

test('수정 중 출발한 배송지를 다시 전송하면 원자적으로 거부하며 취소는 최신 운행을 보존한다', () => {
  const operations = publishedOperations();
  command(operations, { type: 'begin_dispatch_revision' });
  command(operations, { type: 'reassign', orderIds: ['O4'], targetVehicleId: 'G1' });
  command(operations, { type: 'set_scenario', vehicleId: 'G2', stopId: 'O4', scenario: 'shipping' });
  const before = operations.exportCheckpoint();
  assert.throws(() => command(operations, { type: 'publish_dispatch', draftVersion: before.draftVersion }), error => error.code === 'PROTECTED_DESTINATION');
  assert.deepEqual(operations.exportCheckpoint(), before);
  const restored = createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, checkpoint: before });
  assert.deepEqual(restored.snapshot(), operations.snapshot());
  const confirmed = restored.snapshot().fleetDeliveries;
  const canceled = command(restored, { type: 'discard_dispatch_revision' });
  assert.equal(canceled.state.dispatch.phase, 'published');
  assert.deepEqual(canceled.state.fleetDeliveries, confirmed);
  assert.equal(canceled.state.dispatchOrders.find(order => order.id === 'O4').vehicleId, 'G2');
  assert.equal(canceled.state.dispatchOrders.find(order => order.id === 'O4').status, 'current');
});

test('운행을 마친 차량에 다시 전송한 잔여 주문은 출발 가능한 대기 상태가 된다', () => {
  const operations = publishedOperations();
  command(operations, { type: 'set_scenario', vehicleId: 'G2', stopId: 'O4', scenario: 'arrived' });
  command(operations, { type: 'complete_stop', vehicleId: 'G2', stopId: 'O4', hasPhoto: true, confirmedRequestIds: confirmedRequests(operations, ['O4']) });
  assert.equal(operations.snapshot().vehicleStates.G2.phase, 'done');
  command(operations, { type: 'begin_dispatch_revision' });
  command(operations, { type: 'reassign', orderIds: ['O3'], targetVehicleId: 'G2' });
  const saved = operations.exportCheckpoint();
  const restored = createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, checkpoint: saved });
  const published = command(restored, { type: 'publish_dispatch', draftVersion: saved.draftVersion }).state;
  assert.equal(published.vehicleStates.G2.phase, 'idle');
  assert.equal(published.fleetDeliveries.find(order => order.id === 'O4').status, 'done');
  assert.equal(published.fleetDeliveries.find(order => order.id === 'O3').status, 'pending');
  const started = command(restored, { type: 'set_scenario', vehicleId: 'G2', stopId: 'O3', scenario: 'shipping' });
  assert.equal(started.state.fleetDeliveries.find(order => order.id === 'O3').status, 'current');
});

test('기존 분리 배차 기록은 변경하지 않고 수정 불가 사유를 노출한다', () => {
  const legacy = createSourceOperations(day(), { sourceId: 'csv-a' });
  legacy.command({ type: 'set_delivery_tip', expectedRevision: 0, vehicleId: 'G1', stopId: 'O3', body: '주차장 이용' });
  const operations = createDispatchOperations(day(), { sourceId: 'csv-a', operatingDate: '2026-09-16', calculator, checkpoint: legacy.exportCheckpoint() });
  assert.equal(operations.snapshot().dispatch.canAmend, false);
  assert.match(operations.snapshot().dispatch.amendmentBlockedReason, /배정 충돌/);
  const before = operations.exportCheckpoint();
  assert.throws(() => command(operations, { type: 'begin_dispatch_revision' }), error => error.code === 'DESTINATION_SPLIT');
  assert.deepEqual(operations.exportCheckpoint(), before);
});
