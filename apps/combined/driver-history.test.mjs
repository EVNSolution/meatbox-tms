import test from 'node:test';
import assert from 'node:assert/strict';
import { driverHistoryForDate, exampleHistoryDates, sourceDriverHistoryForDate } from './driver-history.mjs';

test('근무 이력 예시는 날짜별 고정 데이터이며 현재 배송 snapshot과 분리된다', () => {
  assert.deepEqual(exampleHistoryDates, ['2026-09-12', '2026-09-14']);
  assert.equal(driverHistoryForDate('2026-09-14').length, 2);
  assert.deepEqual(driverHistoryForDate('2026-09-15'), []);

  const result = driverHistoryForDate('2026-09-12');
  result[0].label = '변경됨';
  assert.equal(driverHistoryForDate('2026-09-12')[0].label, '예시 오전 배차');
});

test('실데이터 근무 이력은 선택 날짜의 원본 기사 배차를 다시 읽어 합산한다', async () => {
  const requested = [];
  const result = await sourceDriverHistoryForDate('2025-09-12', { driver: '홍길동', plate: '76서 2108', originalGroupId: 'old-group' }, async url => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => ({
      groups: [{ id: 'new-group', label: '홍길동' }, { id: 'old-group', label: '김기사' }, { id: 'other', label: '박기사' }],
      orders: [
        { groupId: 'new-group', boxes: 3, sourceRows: 2 },
        { groupId: 'new-group', boxes: 7, sourceRows: 5 },
        { groupId: 'old-group', boxes: 99, sourceRows: 99 },
      ],
    }) };
  });
  assert.deepEqual(requested, ['/api/dispatch-data/days/2025-09-12']);
  assert.deepEqual(result, [{
    date: '2025-09-12', id: 'SOURCE-2025-09-12-old-group', label: '홍길동 배차', vehicle: '76서 2108', destinations: 2, boxes: 10, sourceRows: 7,
  }]);
});

test('실데이터 근무 이력은 없는 날짜를 빈 기록으로 처리하고 잘못된 날짜는 요청하지 않는다', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: false, status: 404 }; };
  assert.deepEqual(await sourceDriverHistoryForDate('2025-09-13', { driver: '홍길동' }, fetcher), []);
  assert.deepEqual(await sourceDriverHistoryForDate('not-a-date', { driver: '홍길동' }, fetcher), []);
  assert.equal(calls, 1);
});

test('동명이인 배송원의 배차는 선택한 원본 그룹이 있으면 합치지 않는다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({
    groups: [{ id: 'G1', label: '김기사' }, { id: 'G2', label: '김기사' }],
    orders: [{ groupId: 'G1', boxes: 2 }, { groupId: 'G2', boxes: 9 }],
  }) });
  for (const [originalGroupId, boxes] of [['G1', 2], ['G2', 9]]) {
    const [record] = await sourceDriverHistoryForDate('2026-09-16', { driver: '김기사', originalGroupId }, fetcher);
    assert.equal(record.destinations, 1);
    assert.equal(record.boxes, boxes);
  }
});
