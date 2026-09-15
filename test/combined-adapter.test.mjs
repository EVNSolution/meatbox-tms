import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSimulation, calculatedEtaText, officialEtaText } from '../apps/combined/simulation-adapter.mjs';

const base = {
  phase: 'delivering',
  simClock: '07:10',
  speed: 5,
  simTime: 25_800_000,
  customerStopId: 'S5',
  truck: { lat: 37.4926, lng: 127.1116, dwelling: false, dwellRemaining: 0 },
  vehicles: [{
    id: 'V1', plate: '서울87바 1234', driver: '김민수', region: '송파·강남', live: true,
    departure: { time: '06:30', source: 'scenario-baseline' },
  }],
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

test('기존 자동 알림의 이모지만 제거하고 수동 안내와 알림 식별자는 보존한다', () => {
  const notices = [
    { id: 1, kind: 'shipping', title: '배송이 출발했습니다 🚚' },
    { id: 2, kind: 'completed', title: '배송이 완료되었습니다 ✅' },
    { id: 3, kind: 'manual', title: '배송이 출발했습니다 🚚', body: '배송 안내 ✅' },
    { id: 4, kind: 'shipping', title: '직접 입력한 제목 🚚' },
  ].map(notice => ({ stopId: 'S5', ...notice }));
  const adapted = adaptSimulation({ ...base, notifications: notices }).deliveries[0].notices;
  assert.deepEqual(adapted.map(notice => [notice.id, notice.title]), [
    [1, '배송이 출발했습니다'], [2, '배송이 완료되었습니다'],
    [3, '배송이 출발했습니다 🚚'], [4, '직접 입력한 제목 🚚'],
  ]);
  assert.equal(adapted[2].body, '배송 안내 ✅');
  assert.equal(notices[0].title, '배송이 출발했습니다 🚚');
});

test('고객 공식 ETA와 계산 ETA를 서로 다른 point 값으로 보존한다', () => {
  const result = adaptSimulation(base);
  assert.equal(officialEtaText(result.deliveries[0]), '08:35');
  assert.equal(calculatedEtaText(result.deliveries[0]), '08:31');
  assert.equal(result.deliveries[0].officialEta.updatedAt, '07:05');
  assert.equal(result.device, null);
  assert.equal(result.vehicle.id, 'V1');
  assert.deepEqual(result.vehicle.departure, { time: '06:30', source: 'scenario-baseline' });
  assert.equal(result.customerStopId, 'S5');
  assert.equal(result.scenarioPreset, null);
  assert.equal(result.scenarioStopId, null);
});

test('시뮬레이션 시각과 차량 위치를 출처와 함께 보존한다', () => {
  const result = adaptSimulation(base);
  assert.equal(result.simTime, 25_800_000);
  assert.deepEqual(result.truck, {
    lat: 37.4926,
    lng: 127.1116,
    locationSource: 'simulation',
    dwelling: false,
    dwellRemaining: 0,
  });

  const withoutCoordinates = adaptSimulation({ ...base, simTime: undefined, truck: { dwelling: true, dwellRemaining: 30 } });
  assert.equal(withoutCoordinates.simTime, null);
  assert.equal(withoutCoordinates.truck.locationSource, null);
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

test('실제 도착 기록을 고객 상태와 타임라인에 표시하고 완료 뒤에도 보존한다', () => {
  for (const status of ['current', 'done']) {
    const input = structuredClone(base);
    input.order[0] = { ...input.order[0], status, arrivedTime: '07:42', deliveredTime: status === 'done' ? '07:46' : null };
    input.customers.S5.status = status === 'done' ? { key: 'delivered', label: '배송 완료' } : { key: 'nearby', label: '인근 배송 중' };
    input.customers.S5.timeline = [
      { label: '배송 중', time: '06:30', state: 'done' },
      { label: '인근 배송 중', time: null, state: status === 'done' ? 'done' : 'current' },
      { label: '배송 완료', time: status === 'done' ? '07:46' : null, state: status === 'done' ? 'current' : 'pending' },
    ];
    const before = structuredClone(input);
    const delivery = adaptSimulation(input).deliveries[0];
    assert.deepEqual(delivery.customerStatus, status === 'done' ? { key: 'delivered', label: '배송 완료' } : { key: 'arrived', label: '배송지 도착' });
    assert.deepEqual(delivery.timeline[1], { label: '배송지 도착', time: '07:42', state: status === 'done' ? 'done' : 'current' });
    assert.deepEqual(input, before);
  }
  const input = structuredClone(base);
  input.customers.S5.status = { key: 'nearby', label: '인근 배송 중' };
  assert.deepEqual(adaptSimulation(input).deliveries[0].customerStatus, input.customers.S5.status);
});

test('잘못된 상태는 조용히 가짜 배송을 만들지 않는다', () => {
  assert.throws(() => adaptSimulation({ phase: 'idle' }), /order 배열/);
});

test('기존 수동 조작 기록은 발생한 일로 표시하고 내부 시나리오 기록은 제외한다', () => {
  const events = [
    { time: '06:35', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 배송 완료' },
    { time: '06:34', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 도착' },
    { time: '06:30', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 배송 중' },
    { time: '06:20', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 출고 준비' },
    { time: '05:50', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 피킹 중' },
    { time: '05:45', type: 'system', message: '수동 상태 선택: 송파·강남 식당 · 주문 접수' },
    { time: '05:45', type: 'system', message: '주문 접수 완료 — 출고 준비 시작 · V1 60박스 / 8개 배송지' },
    { time: '05:45', type: 'system', message: '시나리오 대기 — 가락 MFC 상차 완료 70박스 / 8개 착지' },
    { time: '05:45', type: 'system', message: '시뮬레이션 배속 변경: 5x' },
  ];
  const result = adaptSimulation({ ...base, events });
  assert.deepEqual(result.events.map(event => event.message), [
    '송파·강남 식당 배송 완료', '송파·강남 식당 도착', '송파·강남 식당 배송 출발',
    '송파·강남 식당 출고 준비 완료', '송파·강남 식당 피킹 시작', '송파·강남 식당 주문 접수 완료',
    '주문 접수 완료',
  ]);
  assert.ok(result.events.every(event => event.type === 'stage'));
  assert.equal(result.events[0].time, '06:35');
  assert.equal(events[0].message, '수동 상태 선택: 송파·강남 식당 · 배송 완료');
  const actual = { time: '06:36', type: 'driver', message: '배송 팁 수정: 송파·강남 식당' };
  assert.deepEqual(adaptSimulation({ ...base, events: [actual] }).events, [actual]);
});

test('사건의 원본 시각과 명시적 대상만 보존하고 문구로 대상을 추정하지 않는다', () => {
  const targeted = {
    id: 17,
    ts: 25_800_000,
    time: '07:10',
    type: 'scan',
    message: '구간 스캔: 문정갈비 도착',
    vehicleId: 'V1',
    stopId: 'S5',
    action: 'arrived',
  };
  const untargeted = { ts: 25_740_000, time: '07:09', type: 'scan', message: 'V2 문정갈비 배송 완료' };
  const [first, second] = adaptSimulation({ ...base, events: [targeted, untargeted] }).events;

  assert.deepEqual(first, targeted);
  assert.equal(second.ts, 25_740_000);
  assert.equal(Object.hasOwn(second, 'id'), false);
  assert.equal(Object.hasOwn(second, 'vehicleId'), false);
  assert.equal(Object.hasOwn(second, 'stopId'), false);
});

test('고객 알림의 원본 타임스탬프를 보존한다', () => {
  const result = adaptSimulation({
    ...base,
    notifications: [{ id: 3, stopId: 'S5', ts: 25_800_000, time: '07:10', title: '운영자 안내', body: '도착 전 연락', kind: 'manual' }],
  });
  assert.equal(result.deliveries[0].notices[0].ts, 25_800_000);
});

test('fleet 계약은 live 배송과 synthetic 배송을 한 목록으로 제공한다', () => {
  const input = structuredClone(base);
  input.order[0].vehicleId = 'V1';
  input.order[0].tip = { body: '직접 작성한 팁', author: '김민수', updatedAt: 25_500_000 };
  input.customers.S5.eta.preciseTimeText = '08:31';
  input.customers.S5.eta.windowText = '08:01 ~ 09:01';
  input.customers.S5.eta.windowStart = '08:01';
  input.customers.S5.eta.windowEnd = '09:01';
  input.notifications = [
    { id: 7, stopId: 'S5', title: '운영자 안내', body: '첫 안내', time: '06:30', clock: '06:30', kind: 'manual', channel: '고객 팝업', status: '시연 발송', author: '운영자' },
    { id: 8, stopId: 'V2-S1', title: '운영자 안내', body: '합성 안내', time: '06:31', clock: '06:31', kind: 'manual', channel: '고객 팝업', status: '시연 발송', author: '운영자' },
    { id: 9, stopId: 'S5', title: '운영자 안내', body: '최근 안내', time: '06:32', clock: '06:32', kind: 'manual', channel: '고객 팝업', status: '시연 발송', author: '운영자' },
  ];
  input.fleet = {
    vehicles: [
      { ...input.vehicles[0], planned: { stops: 1, boxes: 12 }, capacityBoxes: 60 },
      { id: 'V2', plate: '예시 차량 002', driver: '예시 배송원 002', region: '권역 데이터 대기', live: false, planned: { stops: 3, boxes: 60 }, capacityBoxes: 60 },
    ],
    deliveries: [{ id: 'V2-S1', vehicleId: 'V2', sequence: 1, name: '예시 배송지 002-1', address: '위치 데이터 대기', boxes: 20, eta: null, status: 'pending', ordered: true, items: [], tip: null }],
  };
  input.scenarioPreset = 'shipping';
  input.scenarioStopId = 'S5';

  const result = adaptSimulation(input);
  assert.equal(result.fleetVehicles.length, 2);
  assert.equal(result.scenarioPreset, 'shipping');
  assert.equal(result.scenarioStopId, 'S5');
  assert.deepEqual(result.fleetDeliveries.map(stop => stop.id), ['S5', 'V2-S1']);
  assert.equal(result.deliveries[0].vehicle.live, true);
  assert.deepEqual(result.deliveries[0].vehicle.departure, { time: '06:30', source: 'scenario-baseline' });
  assert.equal(result.deliveries[0].preciseTimeText, '08:31');
  assert.equal(result.deliveries[0].customerWindowText, '08:01 ~ 09:01');
  assert.deepEqual(result.deliveries[0].tip, { body: '직접 작성한 팁', author: '김민수', updatedAt: '07:05' });
  assert.deepEqual(result.deliveries[0].notices.map(notice => [notice.id, notice.body]), [[7, '첫 안내'], [9, '최근 안내']]);
  assert.equal(result.fleetDeliveries[1].vehicle.live, false);
  assert.equal(result.fleetDeliveries[1].vehicle.departure, null);
  assert.equal(result.fleetDeliveries[1].calculatedEta, null);
  assert.deepEqual(result.fleetDeliveries[1].notices.map(notice => [notice.id, notice.body]), [[8, '합성 안내']]);
});
