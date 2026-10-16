import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCapa, overText, reportNote } from './capa-check.ts';

const regions = { type: 'FeatureCollection', features: [{ properties: { zoneId: 'Z1', label: '강남' } }, { properties: { zoneId: 'Z2', label: '서초' } }] };
const order = (id, vehicleId, over = {}) => ({ id, vehicleId, name: id, address: id, boxes: 10, zoneIds: ['Z1'], weightKg: 50, ...over });
const profile = (capa) => ({ username: 'kim', capa: { stops: null, boxes: null, weightKg: null, ...capa } });
const base = { vehicles: [{ id: 'V1', driver: '김기사' }, { id: 'V2', driver: '이기사' }], regions };

test('a vehicle over any of its driver Capa figures is listed with the figure and its main zone', () => {
  const deliveries = [order('a', 'V1'), order('b', 'V1'), order('c', 'V1', { zoneIds: ['Z2'], boxes: 1 })];
  const report = checkCapa({ ...base, deliveries, assignments: new Map([['V1', 'kim']]), profiles: new Map([['kim', profile({ stops: 2, boxes: 100, weightKg: 100 })]]) });
  assert.equal(report.overs.length, 1);
  assert.deepEqual(report.overs[0].over.map(item => item.kind), ['stops', 'weightKg']);
  assert.equal(report.overs[0].zoneId, 'Z1');
  assert.match(overText(report.overs[0].over[0]), /착지 3곳 \/ 최대 2곳/);
});

test('equal to the limit is not over, and a vehicle without a driver or Capa is told apart from one that passed', () => {
  const deliveries = [order('a', 'V1'), order('b', 'V2')];
  const report = checkCapa({ ...base, deliveries, assignments: new Map([['V1', 'kim']]), profiles: new Map([['kim', profile({ stops: 1, boxes: 10 })]]) });
  assert.equal(report.overs.length, 0);
  assert.equal(report.checked, 1);
  assert.deepEqual(report.unset.map(row => row.vehicleId), ['V2']);
  assert.match(reportNote(report), /1대는 점검하지 못했습니다/);
});

test('an unknown weight is never compared as zero and the note says so', () => {
  const deliveries = [order('a', 'V1', { weightKg: undefined })];
  const report = checkCapa({ ...base, deliveries, assignments: new Map([['V1', 'kim']]), profiles: new Map([['kim', profile({ weightKg: 1 })]]) });
  assert.equal(report.overs.length, 0);
  assert.equal(report.weightUnchecked, true);
  assert.match(reportNote(report), /중량이 없는 주문/);
});

test('vehicles without orders are skipped', () => {
  const report = checkCapa({ ...base, deliveries: [], assignments: new Map(), profiles: new Map() });
  assert.deepEqual(report, { overs: [], unset: [], checked: 0, weightUnchecked: false });
});
