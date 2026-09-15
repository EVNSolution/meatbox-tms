import test from 'node:test';
import assert from 'node:assert/strict';
import { driverHistoryForDate, exampleHistoryDates } from './driver-history.mjs';

test('근무 이력 예시는 날짜별 고정 데이터이며 현재 배송 snapshot과 분리된다', () => {
  assert.deepEqual(exampleHistoryDates, ['2026-09-12', '2026-09-14']);
  assert.equal(driverHistoryForDate('2026-09-14').length, 2);
  assert.deepEqual(driverHistoryForDate('2026-09-15'), []);

  const result = driverHistoryForDate('2026-09-12');
  result[0].label = '변경됨';
  assert.equal(driverHistoryForDate('2026-09-12')[0].label, '예시 오전 배차');
});
