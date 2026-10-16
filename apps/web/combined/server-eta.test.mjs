import test from 'node:test';
import assert from 'node:assert/strict';
import { etaFor, etaNote, etaText, readEta } from './server-eta.ts';

const raw = (extra = {}) => ({
  computedAt: '2026-11-02T09:12:10+09:00', reason: 'departed', departedAt: '2026-11-02T09:12:03+09:00', departureTimeSource: 'device', recomputes: 2,
  stops: [{ stopId: 'O1', sequence: 1, eta: '2026-11-02T09:40:00+09:00', estimated: true }, { stopId: 'O3', sequence: 2, eta: '2026-11-02T09:58:00+09:00', estimated: false, actualAt: '2026-11-02T10:01:00+09:00' }], ...extra,
});

test('a vehicle that has not left has no server ETA, and a malformed one is not read', () => {
  assert.equal(readEta(undefined), null);
  assert.equal(readEta({ stops: [] }), null);
  assert.equal(readEta(raw({ computedAt: '' })), null);
  assert.deepEqual(readEta(raw({ stops: [{ stopId: 'O1', eta: 'x' }, { eta: '2026-11-02T09:40:00+09:00' }, null] })).stops, []);
});

test('a bundle finds its ETA by any of its orders', () => {
  const eta = readEta(raw());
  assert.equal(etaFor(eta, { id: 'B1', orderIds: ['O2', 'O1'] }).stopId, 'O1');
  assert.equal(etaFor(eta, { id: 'O3' }).stopId, 'O3');
  assert.equal(etaFor(eta, { id: 'X', orderIds: ['Y'] }), null);
  assert.equal(etaFor(null, { id: 'O1' }), null);
  assert.equal(etaFor(eta, null), null);
});

test('the time is written in Seoul clock, an unknown position is said, and an actual arrival is shown beside the plan', () => {
  const eta = readEta(raw());
  assert.equal(etaText(eta.stops[0]), '09:40');
  assert.equal(etaText(eta.stops[1]), '예정 09:58 (위치 미확인) · 실제 10:01');
});

test('the note names the departure and its source, the recomputation and the reason, and warns about the model', () => {
  assert.equal(etaNote(readEta(raw())), '서버 ETA: 출발 09:12(기기 시각), 산출 09:12, 재산출 2회, 사유 출발. 직선거리 모델이라 실제 도로와 다를 수 있습니다.');
  assert.match(etaNote(readEta(raw({ departureTimeSource: 'server', reason: 'reordered' }))), /출발 09:12\(서버 수신 시각\).*사유 순서 변경/);
  assert.match(etaNote(readEta(raw({ departedAt: null, reason: 'x' }))), /^서버 ETA: 산출 09:12, 재산출 2회\./);
});
