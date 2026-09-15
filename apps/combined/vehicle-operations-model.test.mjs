import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleOperations, sortVehicleOperations, resolveControlVehicle, resolveControlDelivery, vehicleEvents, deliveryFacts, noticesForDelivery, deliveryRecords, controlPosition } from './vehicle-operations-model.mjs';
import { OperatingSimulation } from '../../lib/operating-simulation.js';
import { adaptSimulation } from './simulation-adapter.mjs';

test('vehicle workload uses assigned IDs, includes held work and distinguishes missing boxes from zero', () => {
  const data = { fleetVehicles: [{ id: 'V2' }, { id: 'V1', live: true }, { id: 'V3' }], fleetDeliveries: [
    { id: 'b', vehicleId: 'V2', boxes: null, status: 'pending' },
    { id: 'a', vehicleId: 'V1', boxes: 0, status: 'current' },
    { id: 'c', vehicleId: 'V1', boxes: 4, status: 'skipped' },
    { id: 'd', vehicleId: 'V1', boxes: 8, status: 'done' },
  ], kpi: { finishEta: '09:30' } };
  const before = structuredClone(data);
  const rows = vehicleOperations(data);
  assert.deepEqual(rows.map(row => row.remainingBoxes), [null, 4, 0]);
  assert.equal(rows[1].heldStops, 1);
  assert.equal(rows[1].remainingStops, 2);
  assert.equal(rows[1].lastArrivalEta, '09:30');
  assert.equal(rows[1].completionEta, null);
  assert.deepEqual(sortVehicleOperations(rows).map(row => row.vehicle.id), ['V2', 'V1', 'V3']);
  assert.deepEqual(sortVehicleOperations(rows, 'boxes').map(row => row.vehicle.id), ['V1', 'V3', 'V2']);
  assert.deepEqual(sortVehicleOperations(rows, 'duration'), rows);
  assert.deepEqual(data, before);
  assert.equal(vehicleOperations({ ...data, kpi: { finishEta: '09:30 완료' } })[1].lastArrivalEta, null);
});

test('historical destination inspection cannot replace the selected vehicle or its current workload', () => {
  const rows = vehicleOperations({ fleetVehicles: [{ id: 'V1' }, { id: 'V2' }], fleetDeliveries: [
    { id: 'done', vehicleId: 'V1', status: 'done', boxes: 3 },
    { id: 'current', vehicleId: 'V1', status: 'current', boxes: 7 },
    { id: 'foreign', vehicleId: 'V2', status: 'pending', boxes: 2 },
  ] });
  assert.equal(resolveControlVehicle(rows, 'V1', 'done').current.id, 'current');
  assert.equal(resolveControlVehicle(rows, 'V1', 'foreign').remainingBoxes, 7);
  assert.equal(resolveControlVehicle(rows, null, 'foreign').vehicle.id, 'V2');
});

test('vanished control selection falls back within the chosen vehicle', () => {
  const current = { id: 'V2-current', status: 'current' };
  const pending = { id: 'V2-pending', status: 'pending' };
  const row = { current, deliveries: [pending, current] };
  assert.equal(resolveControlDelivery(row, 'V2-pending'), pending);
  assert.equal(resolveControlDelivery(row, 'removed-stop'), current);
  assert.equal(resolveControlDelivery({ current: null, deliveries: [pending] }, 'V1-foreign'), pending);
  assert.equal(resolveControlDelivery({ current: null, deliveries: [] }, 'removed-stop'), null);
  assert.equal(resolveControlDelivery(null, 'removed-stop'), null);
});

test('only actual stop facts and matching notices are merged in chronological order', () => {
  const stop = { id: 'S1', vehicleId: 'V1', name: '매장', arrivedAt: '07:00', completedAt: '07:05', timeline: [
    { label: '주문 접수', time: '05:30', state: 'done' },
    { label: '결제 완료', time: '05:30', state: 'done' },
    { label: '도착 예정', time: '08:00', state: 'pending' },
    { label: '배송 완료', time: '07:05', state: 'done' },
  ], notices: [{ id: 'a', stopId: 'S1', time: '07:05' }, { id: 'b', stopId: 'S2', time: '06:00' }, { id: 'c', stopId: 'S1', time: '06:30' }] };
  const data = { vehicle: { id: 'V1' }, events: [
    { time: '07:00', ts: 25200000, stopId: 'S1', vehicleId: 'V1', message: '매장 배송지 도착' },
    { time: '06:00', ts: 21600000, message: '차량 배송 출발' },
    { time: '07:10', stopId: 'S2', message: '다른 배송지' },
    { time: '07:11', stopId: 'S1', vehicleId: 'V2', message: '다른 차량' },
  ] };
  assert.deepEqual(deliveryFacts(data, stop).map(item => item.time), ['05:30', '07:00', '07:05']);
  assert.deepEqual(noticesForDelivery(stop).map(item => item.id), ['c', 'a']);
  assert.equal(vehicleEvents(data, 'V1').length, 1);
  assert.deepEqual(vehicleEvents(data, 'V2'), []);
});

test('delivery records interleave actual history and notices without changing their source data', () => {
  const stop = { id: 'S1', vehicleId: 'V1', name: '매장', timeline: [], notices: [
    { id: 'shared', stopId: 'S1', ts: 21600000, time: '06:00', kind: 'shipping', title: '출발 안내', body: '출발했습니다', status: 'sent' },
    { id: 'late', stopId: 'S1', time: '07:30', title: '도착 안내', body: '도착했습니다', status: 'sent' },
    { id: 'foreign', stopId: 'S2', time: '05:00', title: '다른 배송지', body: '표시 금지' },
  ] };
  const data = { events: [
    { id: 'late-history', stopId: 'S1', vehicleId: 'V1', time: '07:00', message: '배송지 도착' },
    { id: 'shared', stopId: 'S1', vehicleId: 'V1', ts: 19800000, time: '05:30', type: 'stage', message: '배송 출발' },
    { id: 'foreign-vehicle', stopId: 'S1', vehicleId: 'V2', time: '05:00', message: '다른 차량' },
    { id: 'foreign-stop', stopId: 'S2', vehicleId: 'V1', time: '04:00', message: '다른 배송지' },
  ] };
  const before = structuredClone({ data, stop });
  const records = deliveryRecords(data, stop);
  assert.deepEqual(records.map(item => [item.kind, item.id]), [
    ['history', 'shared'], ['notice', 'shared'], ['history', 'late-history'], ['notice', 'late'],
  ]);
  assert.deepEqual(records.map(item => item.key), ['history:shared', 'notice:shared', 'history:late-history', 'notice:late']);
  assert.deepEqual(records[1], {
    id: 'shared', stopId: 'S1', ts: 21600000, time: '06:00', sourceKind: 'shipping', title: '출발 안내',
    body: '출발했습니다', status: 'sent', kind: 'notice', key: 'notice:shared', index: 2,
  });
  assert.deepEqual({ data, stop }, before);
});

test('delivery record ties keep history before notices and missing times last with stable unique keys', () => {
  const stop = { id: 'S1', vehicleId: 'V1', timeline: [], notices: [
    { stopId: 'S1', time: '06:00', title: '동시 알림', body: '알림' },
    { stopId: 'S1', title: '시각 없는 알림', body: '알림' },
    { stopId: 'S1', title: '시각 없는 알림', body: '알림' },
  ] };
  const data = { events: [{ stopId: 'S1', vehicleId: 'V1', time: '06:00', message: '동시 이력' }] };
  const records = deliveryRecords(data, stop);
  assert.deepEqual(records.map(item => item.kind), ['history', 'notice', 'notice', 'notice']);
  assert.equal(new Set(records.map(item => item.key)).size, records.length);
  assert.deepEqual(records.slice(2).map(item => item.key), [
    'notice:unknown:시각 없는 알림', 'notice:unknown:시각 없는 알림:1',
  ]);
});

test('delivery record filters preserve chronological target-isolated records', () => {
  const stop = { id: 'S1', vehicleId: 'V1', timeline: [], notices: [
    { id: 'notice', stopId: 'S1', time: '06:00', title: '안내', body: '본문' },
  ] };
  const data = { events: [{ id: 'history', stopId: 'S1', vehicleId: 'V1', time: '05:00', message: '처리' }] };
  assert.deepEqual(deliveryRecords(data, stop, 'history').map(item => item.id), ['history']);
  assert.deepEqual(deliveryRecords(data, stop, 'notice').map(item => item.id), ['notice']);
  assert.deepEqual(deliveryRecords(data, stop, 'all').map(item => item.id), ['history', 'notice']);
  assert.deepEqual(deliveryRecords(data, stop, 'unknown').map(item => item.id), ['history', 'notice']);
  assert.deepEqual(deliveryRecords(data, null), []);
});

test('live completion updates only that vehicle remaining workload and simulation position is never synthetic GPS', () => {
  const sim = new OperatingSimulation(() => {});
  sim.setScenario('arrived', 'S1');
  let data = adaptSimulation(sim.snapshot());
  let rows = vehicleOperations(data);
  const before = rows[0].remainingBoxes;
  assert.equal(rows[0].remainingStops, 8);
  assert.equal(controlPosition(data, rows[0]).source, 'simulation');
  assert.equal(controlPosition(data, rows[1]), null);
  assert.equal(controlPosition(data, { ...rows[0], remaining: [] }).source, 'simulation');
  const completedBoxes = rows[0].current.boxes;
  sim.setScenario('completed', 'S1');
  data = adaptSimulation(sim.snapshot());
  rows = vehicleOperations(data);
  assert.equal(rows[0].remainingStops, 7);
  assert.equal(rows[0].remainingBoxes, before - completedBoxes);
  assert.equal(rows[1].remainingStops, 35);
  assert.equal(rows[1].lastArrivalEta, null);
});

test('producer scopes and equal-clock occurrence order keep synthetic activity out of the live vehicle', () => {
  const sim = new OperatingSimulation(() => {});
  sim.sendCustomerNotice('V2-S1', '같은 시각 첫 사건', '검증');
  sim.setDeliveryTip('V2-S1', '같은 시각 둘째 사건');
  let data = adaptSimulation(sim.snapshot());
  const stop = data.fleetDeliveries.find(item => item.id === 'V2-S1');
  assert.deepEqual(deliveryFacts(data, stop).map(item => item.type), ['notify', 'driver']);
  assert.ok(vehicleEvents(data, 'V1').every(event => !/예시 배송지/.test(event.message)));
  sim.setScenario('arrived', 'S1');
  data = adaptSimulation(sim.snapshot());
  const facts = deliveryFacts(data, data.deliveries.find(item => item.id === 'S1'));
  assert.equal(facts.filter(item => item.action === 'arrived' || item.message === '배송지 도착').length, 1);
  assert.ok(!vehicleEvents(data, 'V1').some(event => event.action === 'arrived'));
});
