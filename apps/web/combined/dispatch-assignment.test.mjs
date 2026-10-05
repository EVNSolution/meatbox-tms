import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchAssignments, createDispatchFleet } from './dispatch-assignment.mjs';

const group = (id, label, regionNames = ['서울']) => ({ id, label, regionNames });
const order = (id, groupId, boxes) => ({ id, groupId, boxes, coordinates: [127, 37.5], zoneIds: [] });
const day = (date = '2025-09-12') => ({
  schemaVersion: 1,
  date,
  groups: [group('G1', '김기사', ['서울', '경기']), group('G2', '용차로그인', ['인천'])],
  orders: [order('O1', 'G1', 3), order('O2', 'G1', 7), order('O3', 'G2', 11)],
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('실제 기사 표기는 보존하고 차량 번호와 수도권 위치만 안정적인 예시 자료로 만든다', () => {
  const source = day();
  const before = structuredClone(source);
  const first = createDispatchFleet(source);
  const second = createDispatchFleet(structuredClone(source));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(vehicle => vehicle.driver), ['김기사', '용차로그인']);
  assert.match(first[0].plate, /^\d{2}[가-힣] \d{4}$/);
  assert.equal(first[0].region, '서울, 경기');
  for (const vehicle of first) {
    assert.equal(vehicle.live, false);
    assert.equal(vehicle.source, 'demo-vehicle');
    assert.equal(vehicle.location.source, 'demo');
    assert.match(vehicle.location.label, /예시 위치$/);
    assert.ok(vehicle.location.coordinates[0] >= 126.7 && vehicle.location.coordinates[0] <= 127.3);
    assert.ok(vehicle.location.coordinates[1] >= 37.2 && vehicle.location.coordinates[1] <= 37.7);
    assert.deepEqual(Object.keys(vehicle).sort(), ['driver', 'id', 'live', 'location', 'plate', 'region', 'source']);
  }
  assert.deepEqual(source, before);
});

test('기사별 전체 주문 재배정은 주문수와 원본 박스 합계를 보존한다', () => {
  const source = day();
  const before = structuredClone(source);
  const assignments = createDispatchAssignments(source, { storage: null, sourceId: 'csv-a' });
  const ids = assignments.orders().filter(item => item.currentGroupId === 'G1').map(item => item.id);
  assert.deepEqual(assignments.assign(ids, 'G2'), { changedCount: 2, changedBoxes: 10, persisted: false });
  const current = assignments.orders();
  assert.equal(current.length, source.orders.length);
  assert.equal(current.reduce((sum, item) => sum + item.boxes, 0), 21);
  assert.deepEqual(current.map(item => [item.id, item.originalGroupId, item.currentGroupId]), [
    ['O1', 'G1', 'G2'], ['O2', 'G1', 'G2'], ['O3', 'G2', 'G2'],
  ]);
  assert.deepEqual(source, before);
});

test('핀배차는 주문 하나만 이동하고 원 배차로 되돌리면 오버라이드를 제거한다', () => {
  const storage = memoryStorage();
  const assignments = createDispatchAssignments(day(), { storage, sourceId: 'csv-a' });
  assert.deepEqual(assignments.assign(['O3'], 'G1'), { changedCount: 1, changedBoxes: 11, persisted: true });
  assert.equal(assignments.orders().find(item => item.id === 'O3').currentGroupId, 'G1');
  assert.deepEqual(assignments.assign(['O3'], 'G2'), { changedCount: 1, changedBoxes: 11, persisted: true });
  assert.equal(assignments.orders().find(item => item.id === 'O3').currentGroupId, 'G2');
  const record = JSON.parse([...storage.values.values()][0]);
  assert.deepEqual(record.overrides, {});
});

test('대상과 모든 주문을 먼저 검증하며 빈 선택과 무변경은 일부도 수정하지 않는다', () => {
  const assignments = createDispatchAssignments(day(), { storage: null });
  assert.throws(() => assignments.assign(['O1'], 'UNKNOWN'), /대상 기사/);
  assert.throws(() => assignments.assign([], 'G2'), /주문을 선택/);
  assert.throws(() => assignments.assign(['O1', 'UNKNOWN'], 'G2'), /재배정 주문/);
  assert.throws(() => assignments.assign(['O1'], 'G1'), /이미 해당 기사/);
  assert.deepEqual(assignments.orders().map(item => item.currentGroupId), ['G1', 'G1', 'G2']);
});

test('저장 결과는 자료와 날짜별로 격리되고 유효한 레코드만 복원한다', () => {
  const storage = memoryStorage();
  const source = day();
  createDispatchAssignments(source, { storage, sourceId: 'csv-a' }).assign(['O1'], 'G2');
  const restored = createDispatchAssignments(source, { storage, sourceId: 'csv-a' });
  assert.equal(restored.restored, true);
  assert.equal(restored.orders()[0].currentGroupId, 'G2');
  assert.equal(createDispatchAssignments(source, { storage, sourceId: 'csv-b' }).restored, false);
  assert.equal(createDispatchAssignments(day('2025-09-13'), { storage, sourceId: 'csv-a' }).restored, false);
});

test('손상되거나 다른 주문과 기사를 참조하는 저장 상태는 전부 무시한다', () => {
  for (const value of [
    '{broken',
    JSON.stringify({ schemaVersion: 1, sourceId: 'csv-a', date: '2025-09-12', overrides: { UNKNOWN: 'G2' } }),
    JSON.stringify({ schemaVersion: 1, sourceId: 'csv-a', date: '2025-09-12', overrides: { O1: 'UNKNOWN' } }),
  ]) {
    const storage = memoryStorage({ 'meatbox.dispatch.assignments.v1:csv-a:2025-09-12': value });
    const assignments = createDispatchAssignments(day(), { storage, sourceId: 'csv-a' });
    assert.equal(assignments.restored, false);
    assert.deepEqual(assignments.orders().map(item => item.currentGroupId), ['G1', 'G1', 'G2']);
  }
});

test('브라우저 저장이 막혀도 메모리 재배정은 유지한다', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const assignments = createDispatchAssignments(day(), { storage, sourceId: 'csv-a' });
  assert.deepEqual(assignments.assign(['O1'], 'G2'), { changedCount: 1, changedBoxes: 3, persisted: false });
  assert.equal(assignments.orders()[0].currentGroupId, 'G2');
});
