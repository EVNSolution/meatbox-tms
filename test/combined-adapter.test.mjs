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

test('fleet 계약은 live 배송과 synthetic 배송을 한 목록으로 제공한다', () => {
  const input = structuredClone(base);
  input.order[0].vehicleId = 'V1';
  input.order[0].tip = { body: '직접 작성한 팁', author: '김민수', updatedAt: 25_500_000 };
  input.customers.S5.eta.preciseTimeText = '08:31';
  input.customers.S5.eta.windowText = '08:01 ~ 09:01';
  input.customers.S5.eta.windowStart = '08:01';
  input.customers.S5.eta.windowEnd = '09:01';
  input.notifications[0] = { id: 7, stopId: 'S5', title: '운영자 안내', body: '문자 그대로', time: '06:30', clock: '06:30', kind: 'manual', channel: '고객 팝업', status: '시연 발송', author: '운영자' };
  input.fleet = {
    vehicles: [
      { ...input.vehicles[0], planned: { stops: 1, boxes: 12 }, capacityBoxes: 60 },
      { id: 'V2', plate: '예시 차량 002', driver: '예시 배송원 002', region: '권역 데이터 대기', live: false, planned: { stops: 3, boxes: 60 }, capacityBoxes: 60 },
    ],
    deliveries: [{ id: 'V2-S1', vehicleId: 'V2', sequence: 1, name: '예시 배송지 002-1', address: '위치 데이터 대기', boxes: 20, eta: null, status: 'pending', ordered: true, items: [], tip: null }],
  };

  const result = adaptSimulation(input);
  assert.equal(result.fleetVehicles.length, 2);
  assert.deepEqual(result.fleetDeliveries.map(stop => stop.id), ['S5', 'V2-S1']);
  assert.equal(result.deliveries[0].vehicle.live, true);
  assert.equal(result.deliveries[0].preciseTimeText, '08:31');
  assert.equal(result.deliveries[0].customerWindowText, '08:01 ~ 09:01');
  assert.deepEqual(result.deliveries[0].tip, { body: '직접 작성한 팁', author: '김민수', updatedAt: '07:05' });
  assert.deepEqual(result.deliveries[0].notices[0], {
    id: 7, stopId: 'S5', title: '운영자 안내', body: '문자 그대로', time: '06:30', clock: '06:30', kind: 'manual', channel: '고객 팝업', status: '시연 발송', author: '운영자',
  });
  assert.equal(result.fleetDeliveries[1].vehicle.live, false);
  assert.equal(result.fleetDeliveries[1].calculatedEta, null);
  assert.equal(result.fleetDeliveries[1].notices.length, 0);
});
