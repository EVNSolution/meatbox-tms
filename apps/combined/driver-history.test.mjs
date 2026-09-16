import test from 'node:test';
import assert from 'node:assert/strict';
import { driverHistoryForDate, driverOperatingDate, exampleHistoryDates, latestPastHistoryDate, selectedHistoryVehicle, sourceDriverHistoryForDate } from './driver-history.mjs';

test('근무 이력 운영일은 명시값을 우선하고 첫 진입 날짜는 운영일 이전 최신 기록을 고른다', () => {
  const dates = [{ date: '2026-09-14' }, { date: '2026-09-15' }, { date: '2026-09-16' }, { date: '2026-09-17' }];
  assert.equal(driverOperatingDate({ operatingDate: '2026-09-16', dates }, '2026-09-18'), '2026-09-16');
  assert.equal(driverOperatingDate({ dates }, '2026-09-18'), '2026-09-16');
  assert.equal(driverOperatingDate({ dates: [{ date: '2025-09-12' }] }, '2026-09-18'), '2026-09-18');
  assert.equal(latestPastHistoryDate(dates, '2026-09-16', '2026-09-16'), '2026-09-15');
});

test('근무 이력은 외부에서 고른 배송원을 사용하고 해제하거나 찾을 수 없으면 다른 배송원으로 대체하지 않는다', () => {
  const vehicles = [{ id: 'G1', driver: '김기사' }, { id: 'G2', driver: '박기사' }];
  assert.equal(selectedHistoryVehicle(vehicles, 'G2', vehicles[0]), vehicles[1]);
  assert.equal(selectedHistoryVehicle(vehicles, '', vehicles[0]), null);
  assert.equal(selectedHistoryVehicle(vehicles, 'unknown', vehicles[0]), null);
  assert.equal(selectedHistoryVehicle(vehicles, null, vehicles[0]), vehicles[0]);
  assert.equal(selectedHistoryVehicle(vehicles, null, null), null);
});

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
        { groupId: 'new-group', name: '같은 곳', address: '서울 1', coordinates: [127, 37.5], boxes: 3, sourceRows: 2 },
        { groupId: 'new-group', name: '같은 곳', address: '서울 1', coordinates: [127, 37.5], boxes: 7, sourceRows: 5 },
        { groupId: 'old-group', boxes: 99, sourceRows: 99 },
      ],
    }) };
  });
  assert.deepEqual(requested, ['/api/dispatch-data/days/2025-09-12']);
  assert.deepEqual(result, [{
    date: '2025-09-12', id: 'SOURCE-2025-09-12-old-group', label: '홍길동 배차', vehicle: '76서 2108', destinations: 1, boxes: 10, sourceRows: 7,
    plannedStartAt: '06:30', plannedEndAt: '06:54',
  }]);
});

test('실데이터 근무 이력은 없는 날짜를 빈 기록으로 처리하고 잘못된 날짜는 요청하지 않는다', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: false, status: 404 }; };
  assert.deepEqual(await sourceDriverHistoryForDate('2025-09-13', { driver: '홍길동' }, fetcher), []);
  assert.deepEqual(await sourceDriverHistoryForDate('not-a-date', { driver: '홍길동' }, fetcher), []);
  assert.equal(calls, 1);
});

test('운영일과 미래 원자료는 근무 이력으로 조회하지 않는다', async () => {
  const identity = { driver: '김기사', operatingDate: '2026-09-16' };
  const fetcher = () => assert.fail('운영일 이후 원자료를 요청하지 않아야 함');
  assert.deepEqual(await sourceDriverHistoryForDate('2026-09-16', identity, fetcher), []);
  assert.deepEqual(await sourceDriverHistoryForDate('2026-09-17', identity, fetcher), []);
});

test('과거 배차의 박스 수량이 없으면 0으로 꾸미지 않는다', async () => {
  const [record] = await sourceDriverHistoryForDate('2026-09-15', { driver: '김기사', originalGroupId: 'G1' }, async () => ({ ok: true, json: async () => ({
    groups: [{ id: 'G1', label: '김기사' }], orders: [{ id: 'O1', groupId: 'G1', name: '매장', address: '서울', boxes: null }],
  }) }));
  assert.equal(record.destinations, 1);
  assert.equal(record.boxes, null);
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
    assert.equal(record.plannedStartAt, null);
    assert.equal(record.plannedEndAt, null);
  }
});

test('선택한 배송원이 없는 날짜에는 같은 그룹 번호의 다른 배송원 기록을 반환하지 않는다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({
    groups: [{ id: 'G1', label: '다른기사' }],
    orders: [{ groupId: 'G1', boxes: 99 }],
  }) });
  assert.deepEqual(await sourceDriverHistoryForDate('2026-09-16', { driver: '김기사', originalGroupId: 'G1' }, fetcher), []);
  assert.deepEqual(await sourceDriverHistoryForDate('2026-09-16', {}, () => assert.fail('배송원 미선택은 조회하지 않아야 함')), []);
});

test('동명이인 중 선택한 그룹을 찾을 수 없으면 이력을 합산하지 않는다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({
    groups: [{ id: 'G1', label: '김기사' }, { id: 'G2', label: '김기사' }],
    orders: [{ groupId: 'G1', boxes: 2 }, { groupId: 'G2', boxes: 9 }],
  }) });
  await assert.rejects(sourceDriverHistoryForDate('2026-09-16', { driver: '김기사', originalGroupId: 'old-group' }, fetcher), /배송원을 구분할 수 없어/);
});
