import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSimulation, calculatedEtaText, officialEtaText } from '../apps/combined/simulation-adapter.mjs';

const base = {
  phase: 'delivering',
  simClock: '07:10',
  speed: 5,
  customerStopId: 'S5',
  vehicles: [{ id: 'V1', plate: '서울87바 1234', driver: '김민수', region: '송파·강남', live: true }],
  customers: {
    S5: {
      ordered: true,
      status: { key: 'shipping', label: '배송 중' },
      eta: { timeText: '08:35', reason: '배송 출발', deltaMin: 0, updatedAt: 25_500_000 },
      timeline: [{ label: '배송 중', time: '06:30', state: 'current' }],
    },
  },
  notifications: [{ stopId: 'S5', title: '배송 출발', body: '08:35 도착 예정', time: '06:30' }],
  events: [{ time: '06:30', type: 'scan', message: '배송 출발' }],
  incidents: [],
  order: [{
    id: 'S5', name: '식당', address: '서울', boxes: 12, status: 'current',
    eta: '08:31', arrivedTime: null, deliveredTime: null, items: [],
  }],
};

test('고객 공식 ETA와 계산 ETA를 서로 다른 point 값으로 보존한다', () => {
  const result = adaptSimulation(base);
  assert.equal(officialEtaText(result.deliveries[0]), '08:35');
  assert.equal(calculatedEtaText(result.deliveries[0]), '08:31');
  assert.equal(result.deliveries[0].officialEta.updatedAt, '07:05');
  assert.equal(result.device, null);
  assert.equal(result.vehicle.id, 'V1');
  assert.equal(result.customerStopId, 'S5');
});

test('미주문, 완료, 건너뜀 상태와 공급된 시각만 그대로 옮긴다', () => {
  const input = structuredClone(base);
  input.phase = 'unordered';
  input.order = [
    { ...input.order[0], status: 'pending', eta: '08:31' },
    { ...input.order[0], id: 'S1', status: 'done', eta: '07:44', arrivedTime: '07:42', deliveredTime: '07:46' },
    { ...input.order[0], id: 'S2', status: 'skipped', eta: null },
  ];
  input.customers.S5 = { ordered: false, status: { key: 'unordered', label: '주문 전' }, timeline: [], eta: null };
  input.customers.S1 = { ordered: true, status: { key: 'delivered', label: '배송 완료' }, timeline: [], eta: null };
  input.customers.S2 = { ordered: true, status: { key: 'held', label: '배송 보류' }, timeline: [], eta: null };

  const result = adaptSimulation(input);
  assert.deepEqual(result.deliveries.map(item => [item.id, item.ordered, item.status, item.arrivedAt, item.completedAt]), [
    ['S5', false, 'pending', null, null],
    ['S1', true, 'done', '07:42', '07:46'],
    ['S2', true, 'skipped', null, null],
  ]);
  assert.equal(officialEtaText(result.deliveries[2]), '미확인');
});

test('배열 순서가 바뀌면 표시 순서만 원본 스냅샷대로 바뀐다', () => {
  const input = structuredClone(base);
  input.order = [
    { ...input.order[0], id: 'S3', name: '세 번째' },
    { ...input.order[0], id: 'S1', name: '첫 번째' },
  ];
  const result = adaptSimulation(input);
  assert.deepEqual(result.deliveries.map(item => [item.id, item.sequence]), [['S3', 1], ['S1', 2]]);
});

test('잘못된 상태는 조용히 가짜 배송을 만들지 않는다', () => {
  assert.throws(() => adaptSimulation({ phase: 'idle' }), /order 배열/);
});
