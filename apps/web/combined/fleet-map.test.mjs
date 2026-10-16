import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetCounts, fleetPositions, OLD_AFTER_SECONDS, positionOf, positionText } from './fleet-map.ts';

const NOW = Date.parse('2026-11-02T10:00:00+09:00');
const driverAt = seconds => ({ id: 'V1', location: { coordinates: [127, 37.5], source: 'driver', at: new Date(NOW - seconds * 1000).toISOString(), accuracyM: 12 } });

test('a driver-app position keeps its source, its age and its accuracy', () => {
  const position = positionOf(driverAt(180), NOW);
  assert.deepEqual([position.source, position.ageSeconds, position.old, position.accuracyM], ['driver', 180, false, 12]);
  assert.equal(positionText(position), '기사 앱 위치 · 3분 전');
});

test('a position that has not been renewed for ten minutes is drawn but called old', () => {
  const old = positionOf(driverAt(OLD_AFTER_SECONDS + 1), NOW);
  assert.equal(old.old, true);
  assert.match(positionText(old), /오래된 위치/);
  assert.equal(positionOf(driverAt(OLD_AFTER_SECONDS), NOW).old, false);
  assert.equal(positionOf(driverAt(-30), NOW).ageSeconds, 0, '시계가 앞서도 음수 나이가 되지 않는다');
});

test('the vehicle reference place is not presented as a GPS fix', () => {
  const position = positionOf({ id: 'V2', location: { coordinates: [127.1, 37.4], source: 'demo', label: '서울 예시 위치' } }, NOW);
  assert.deepEqual([position.source, position.at, position.old], ['reference', null, false]);
  assert.equal(positionText(position), '기준 위치 (기사 앱 위치 미수신)');
});

test('a driver sample without a readable time is old, and a bad place is no position at all', () => {
  const noTime = positionOf({ id: 'V3', location: { coordinates: [127, 37], source: 'driver' } }, NOW);
  assert.equal(noTime.old, true);
  assert.match(positionText(noTime), /수신 시각 미확인, 오래된 위치/);
  for (const location of [null, undefined, {}, { coordinates: [200, 10] }, { coordinates: [127, 95] }, { coordinates: ['a', 1] }, { coordinates: [127] }, { coordinates: [NaN, 1] }]) {
    assert.equal(positionOf({ id: 'X', location }, NOW), null);
  }
});

test('the fleet is split into the vehicles with a place and those without, and counted in words', () => {
  const { positions, missing } = fleetPositions([driverAt(10), { ...driverAt(2000), id: 'V2' }, { id: 'V3', location: { coordinates: [127, 37], source: 'demo' } }, { id: 'V4' }], NOW);
  assert.deepEqual(positions.map(item => item.vehicleId), ['V1', 'V2', 'V3']);
  assert.deepEqual(missing.map(item => item.id), ['V4']);
  assert.equal(fleetCounts(positions, missing), '기사 앱 위치 1대, 오래된 위치 1대, 기준 위치 1대, 위치 없음 1대.');
});
