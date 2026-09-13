const test = require('node:test');
const assert = require('node:assert');
const { secondsUntilArrival, marginMinutes, etaWindow, BASE_ROAD_FACTOR } = require('../src/eta');

// 단순 검증용 가짜 leg: 각 600초
const legs = {
  'MFC>S1': { duration: 600 }, 'S1>S2': { duration: 600 }, 'S2>S3': { duration: 600 },
};
const base = {
  remaining: ['S1', 'S2', 'S3'], fromId: 'MFC', legProgress: 0, dwellRemaining: 0,
  legs, serviceTimeSec: 240,
};

test('첫 정차지 ETA = 첫 leg 이동시간', () => {
  const s = secondsUntilArrival({ ...base, targetStopId: 'S1' });
  assert.strictEqual(s, 600 * BASE_ROAD_FACTOR);
});

test('세 번째 정차지 ETA = 이동 3구간 + 중간 서비스 2회', () => {
  const s = secondsUntilArrival({ ...base, targetStopId: 'S3' });
  assert.strictEqual(s, 3 * 600 * BASE_ROAD_FACTOR + 2 * 240);
});

test('현재 leg 진행률만큼 이동시간 차감', () => {
  const s = secondsUntilArrival({ ...base, targetStopId: 'S1', legProgress: 0.5 });
  assert.strictEqual(s, 300 * BASE_ROAD_FACTOR);
});

test('정차 중 남은 하차 시간이 더해진다', () => {
  const s = secondsUntilArrival({ ...base, targetStopId: 'S1', dwellRemaining: 120 });
  assert.strictEqual(s, 600 * BASE_ROAD_FACTOR + 120);
});

test('교통 계수는 해당 leg에만, 전역 계수는 전 구간에 적용', () => {
  const withLeg = secondsUntilArrival({ ...base, targetStopId: 'S2', legFactors: { 'MFC>S1': 2 } });
  assert.strictEqual(withLeg, (600 * 2 + 600) * BASE_ROAD_FACTOR + 240);
  const withGlobal = secondsUntilArrival({ ...base, targetStopId: 'S2', globalFactor: 1.5 });
  assert.strictEqual(withGlobal, (600 + 600) * 1.5 * BASE_ROAD_FACTOR + 240);
});

test('ETA 마진: 출발 전 30분 → 진행되며 축소 → 인근 5분', () => {
  assert.strictEqual(marginMinutes(4, false), 30);
  assert.strictEqual(marginMinutes(4, true), 20);
  assert.strictEqual(marginMinutes(2, true), 10);
  assert.strictEqual(marginMinutes(0, true), 5);
});

test('ETA 창은 5분 단위로 정렬', () => {
  const arrival = (7 * 60 + 23) * 60 * 1000; // 07:23
  const { start, end } = etaWindow(arrival, 5);
  assert.strictEqual(start, (7 * 60 + 15) * 60 * 1000); // 07:15
  assert.strictEqual(end, (7 * 60 + 30) * 60 * 1000);   // 07:30
});

test('존재하지 않는 목적지는 에러', () => {
  assert.throws(() => secondsUntilArrival({ ...base, targetStopId: 'S9' }));
});
