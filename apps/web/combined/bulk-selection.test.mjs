import test from 'node:test';
import assert from 'node:assert/strict';
import { addUnits, pointsInRectangle, pruneSelection, summarizeSelection, toggleUnits, transferPreview } from './bulk-selection.mjs';

const deliveries = [
  { id: 'O1', name: '정육점 A', address: '서울 1', assignmentUnitId: 'D1', vehicleId: 'G1', boxes: 4 },
  { id: 'O2', name: '정육점 A', address: '서울 1', assignmentUnitId: 'D1', vehicleId: 'G1', boxes: 6 },
  { id: 'O3', name: '식당 B', address: '서울 2', assignmentUnitId: 'D2', vehicleId: 'G2', boxes: 11 },
  { id: 'O4', name: '마트 C', address: '서울 3', assignmentUnitId: 'D3', vehicleId: 'G2', boxes: 3, assignmentProtected: true },
  { id: 'O5', name: '카페 D', address: '서울 4', vehicleId: 'G1', boxes: 2 },
];

test('한 주문을 고르면 같은 배송지 묶음의 모든 주문이 선택된다', () => {
  const { selection, skippedProtected } = addUnits(new Set(), deliveries, ['O1']);
  assert.deepEqual([...selection].sort(), ['O1', 'O2']);
  assert.equal(skippedProtected, 0);
});

test('묶음 번호가 없는 주문은 한 건 단위로 선택된다', () => {
  assert.deepEqual([...addUnits(new Set(), deliveries, ['O5']).selection], ['O5']);
});

test('진행 중이거나 완료된 묶음은 선택에 들어가지 않고 건너뛴 곳 수를 알려 준다', () => {
  const result = addUnits(new Set(['O3']), deliveries, ['O4', 'O1']);
  assert.deepEqual([...result.selection].sort(), ['O1', 'O2', 'O3']);
  assert.equal(result.skippedProtected, 1);
});

test('이미 모두 선택된 묶음을 다시 고르면 해제하고, 일부만 선택돼 있으면 모두 선택한다', () => {
  const all = addUnits(new Set(), deliveries, ['O1']).selection;
  assert.deepEqual([...toggleUnits(all, deliveries, ['O2']).selection], []);
  const partial = new Set(['O1']);
  assert.deepEqual([...toggleUnits(partial, deliveries, ['O1']).selection].sort(), ['O1', 'O2']);
  const mixed = toggleUnits(new Set(['O3']), deliveries, ['O3', 'O5']).selection;
  assert.deepEqual([...mixed].sort(), ['O3', 'O5']);
});

test('겹친 지점의 주문을 함께 고르면 해제도 함께 한다', () => {
  const picked = toggleUnits(new Set(), deliveries, ['O1', 'O3']).selection;
  assert.deepEqual([...picked].sort(), ['O1', 'O2', 'O3']);
  assert.deepEqual([...toggleUnits(picked, deliveries, ['O1', 'O3']).selection], []);
});

test('알 수 없는 주문 번호는 무시하고 원래 선택을 바꾸지 않는다', () => {
  const original = new Set(['O3']);
  const result = addUnits(original, deliveries, ['nope']);
  assert.deepEqual([...result.selection], ['O3']);
  assert.deepEqual([...original], ['O3']);
});

test('자료가 바뀌면 사라졌거나 보호 상태가 된 주문은 선택에서 빠진다', () => {
  const next = deliveries.flatMap(item => item.id === 'O3' ? [] : [item.id === 'O1' ? { ...item, assignmentProtected: true } : item]);
  assert.deepEqual([...pruneSelection(new Set(['O1', 'O2', 'O3']), next)], ['O2']);
});

test('선택 요약은 배송지 곳 수, 주문 건수, 박스 합을 세고 박스를 모르면 합계를 만들지 않는다', () => {
  const summary = summarizeSelection(new Set(['O1', 'O2', 'O3']), deliveries);
  assert.deepEqual([summary.destinationCount, summary.orderCount, summary.boxes], [2, 3, 21]);
  assert.deepEqual(summary.orderIds, ['O1', 'O2', 'O3']);
  const unknown = summarizeSelection(new Set(['O1', 'O3']), deliveries.map(item => item.id === 'O3' ? { ...item, boxes: undefined } : item));
  assert.equal(unknown.boxes, null);
  assert.deepEqual([summarizeSelection(new Set(), deliveries).orderCount, summarizeSelection(new Set(), deliveries).boxes], [0, 0]);
});

test('이관 미리보기는 이미 대상 차량에 있는 주문을 옮기지 않는 것으로 센다', () => {
  const selected = deliveries.filter(item => ['O1', 'O2', 'O3'].includes(item.id));
  const toG2 = transferPreview(selected, 'G2');
  assert.deepEqual([toG2.movingCount, toG2.unchangedCount, toG2.boxes], [2, 1, 10]);
  const toG1 = transferPreview(selected, 'G1');
  assert.deepEqual([toG1.movingCount, toG1.unchangedCount, toG1.boxes], [1, 2, 11]);
  assert.deepEqual([transferPreview(selected, 'G9').movingCount, transferPreview(selected, 'G9').boxes], [3, 21]);
  assert.equal(transferPreview([], 'G1').movingCount, 0);
});

test('드래그 범위는 어느 방향으로 그어도 안쪽(경계 포함)의 점만 고른다', () => {
  const points = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 50, y: 50 }, { id: 'c', x: 100, y: 100 }, { id: 'd', x: Number.NaN, y: 20 }];
  assert.deepEqual(pointsInRectangle(points, { x: 0, y: 0 }, { x: 50, y: 50 }), ['a', 'b']);
  assert.deepEqual(pointsInRectangle(points, { x: 50, y: 50 }, { x: 0, y: 0 }), ['a', 'b']);
  assert.deepEqual(pointsInRectangle(points, { x: 60, y: 60 }, { x: 120, y: 120 }), ['c']);
  assert.deepEqual(pointsInRectangle(points, { x: 200, y: 200 }, { x: 300, y: 300 }), []);
});
