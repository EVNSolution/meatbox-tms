import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceViewerPlan, transportConditionText } from './source-viewer-plan.mjs';

const stop = (id, coordinates, extra = {}) => ({ id, vehicleId: 'V1', status: 'pending', coordinates, boxes: 1, notices: [], ...extra });

test('순서 변경은 운영 예상만 다시 계산하고 주문 사실은 바꾸지 않는다', () => {
  const deliveries = [stop('A', [127, 37.5]), stop('B', [127.2, 37.5])];
  const before = structuredClone(deliveries);
  const first = sourceViewerPlan({ date: '2026-09-16', deliveries, vehicleId: 'V1' });
  const reordered = sourceViewerPlan({ date: '2026-09-16', deliveries: [first.deliveries[1], first.deliveries[0]], vehicleId: 'V1' });
  assert.equal(first.departureText, '06:30');
  assert.equal(first.timing.departureMs, Date.parse('2026-09-16T06:30:00+09:00'));
  assert.equal(first.deliveries[0].preciseTimeText, '06:50');
  assert.equal(first.deliveries[0].customerWindowText, '06:20 ~ 07:20');
  assert.notEqual(reordered.deliveries[0].preciseTimeText, first.deliveries[1].preciseTimeText);
  assert.equal(reordered.deliveries[0].preciseTimeText, '06:50');
  assert.equal(reordered.deliveries[0].etaSource, 'operating-plan');
  assert.deepEqual(deliveries, before);
  assert.deepEqual(reordered.deliveries.map(item => [item.id, item.status, item.boxes, item.notices]), [
    ['B', 'pending', 1, []], ['A', 'pending', 1, []],
  ]);
});

test('동일 좌표는 추가 이동 없이 하차 시간만 더한다', () => {
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [stop('A', [127, 37.5]), stop('B', [127, 37.5])] });
  assert.equal(plan.deliveries[0].preciseTimeText, '06:50');
  assert.equal(plan.deliveries[1].preciseTimeText, '06:54');
  assert.equal(plan.finishText, '06:58');
});

test('좌표 결측과 보류는 ETA 또는 최종 완료를 단정하지 않는다', () => {
  const missing = sourceViewerPlan({ date: '2026-09-16', deliveries: [stop('A', null), stop('B', [127, 37.5])] });
  assert.equal(missing.deliveries[0].preciseTimeText, undefined);
  assert.equal(missing.deliveries[1].preciseTimeText, undefined);
  assert.equal(missing.finishText, '완료 예상 미확인');
  assert.equal(missing.timing.unknownStops, 2);
  const held = sourceViewerPlan({ date: '2026-09-16', deliveries: [stop('A', [127, 37.5]), stop('H', null, { status: 'skipped' })] });
  assert.equal(held.finishText, '보류 배송 확인');
  assert.equal(held.timing.heldStops, 1);
});

test('실제 완료는 주문 기록을 보존하고 이후 cursor와 전체 완료 시각을 고정한다', () => {
  const completed = stop('A', [127, 37.5], { status: 'done', completedAt: '07:10', timeline: [{ label: '배송 완료', time: '07:10' }] });
  const pending = stop('B', [127, 37.5]);
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [completed, pending] });
  assert.equal(plan.deliveries[1].preciseTimeText, '07:10');
  assert.equal(plan.deliveries[0].completedAt, '07:10');
  assert.deepEqual(plan.deliveries[0].timeline, completed.timeline);
  const done = sourceViewerPlan({ date: '2026-09-16', deliveries: [completed] });
  assert.equal(done.finishText, '07:10');
});

test('실제 도착은 예상 필드로 위장하지 않고 이후 계산의 기준만 바꾼다', () => {
  const arrived = stop('A', [127, 37.5], { status: 'current', arrivedAt: '07:05' });
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [arrived, stop('B', [127, 37.5])] });
  assert.equal(plan.deliveries[0].preciseTimeText, undefined);
  assert.equal(plan.deliveries[0].customerWindowText, undefined);
  assert.equal(plan.deliveries[0].arrivedAt, '07:05');
  assert.equal(plan.deliveries[1].preciseTimeText, '07:09');
});

test('실제 출발 사건은 계획 출발을 바꾸지 않고 별도 운영 시각으로 보존한다', () => {
  const events = [{ id: 'ship', action: 'shipping', vehicleId: 'V1', ts: Date.parse('2026-09-16T06:47:00+09:00') }];
  const before = structuredClone(events);
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [stop('A', [127, 37.5])], events, vehicleId: 'V1' });
  assert.equal(plan.departureText, '06:30');
  assert.equal(plan.timing.actualDepartureText, '06:47');
  assert.deepEqual(events, before);
});

test('실제 사건의 초는 이력과 같은 분으로 내리고 이후 계산 ETA는 분 단위 반올림한다', () => {
  const shippingAt = Date.parse('2026-09-16T08:28:45+09:00');
  const plan = sourceViewerPlan({
    date: '2026-09-16', deliveries: [stop('A', [127, 37.5])], vehicleId: 'V1',
    events: [{ action: 'shipping', vehicleId: 'V1', ts: shippingAt, time: '08:28' }],
  });
  assert.equal(plan.timing.actualDepartureText, '08:28');
  assert.equal(plan.deliveries[0].preciseTimeText, '08:49');

  const completed = sourceViewerPlan({
    date: '2026-09-16', deliveries: [stop('A', [127, 37.5], { status: 'done' })], vehicleId: 'V1',
    events: [{ action: 'completed', vehicleId: 'V1', stopId: 'A', ts: shippingAt, time: '08:28' }],
  });
  assert.equal(completed.finishText, '08:28');
  assert.equal(completed.timing.lastArrivalText, '08:28');
});

test('늦은 실제 출발은 고정 출발을 보존하면서 남은 계획 ETA를 과거 밖으로 민다', () => {
  const events = [{ action: 'shipping', vehicleId: 'V1', time: '07:58' }];
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [
    stop('A', [127, 37.5]), stop('B', [127, 37.5]),
  ], events, vehicleId: 'V1' });
  assert.equal(plan.departureText, '06:30');
  assert.equal(plan.timing.actualDepartureText, '07:58');
  assert.equal(plan.deliveries[0].preciseTimeText, '08:18');
  assert.equal(plan.deliveries[0].customerWindowText, '07:48 ~ 08:48');
  assert.equal(plan.deliveries[1].preciseTimeText, '08:22');
  assert.equal(plan.finishText, '08:26');
  assert.equal(plan.timing.remainingMinutes, 28);
  assert.equal(plan.timing.durationMinutes, 116);
});

test('이전 운영 계획 메타데이터가 일부 빠져도 늦은 출발 뒤 과거 고객 범위를 재사용하지 않는다', () => {
  const delivery = stop('A', [127, 37.5], {
    calculatedEta: '06:50', preciseTimeText: '06:50',
    customerWindowStart: '06:20', customerWindowEnd: '07:20', customerWindowText: '06:20 ~ 07:20',
    etaSource: 'operating-plan',
  });
  const plan = sourceViewerPlan({
    date: '2026-09-16', deliveries: [delivery], vehicleId: 'V1',
    events: [{ action: 'shipping', vehicleId: 'V1', time: '07:58' }],
  });
  assert.equal(plan.deliveries[0].preciseTimeText, '08:18');
  assert.equal(plan.deliveries[0].customerWindowText, '07:48 ~ 08:48');
  assert.equal(delivery.customerWindowText, '06:20 ~ 07:20');
});

test('실제 도착과 완료는 이후 남은 예상의 기준이며 다른 차량 사건은 섞이지 않는다', () => {
  const deliveries = [
    stop('A', [127, 37.5], { status: 'done' }),
    stop('B', [127, 37.5], { status: 'current' }),
    stop('C', [127, 37.5]),
  ];
  const events = [
    { action: 'shipping', vehicleId: 'V1', time: '07:58' },
    { action: 'completed', vehicleId: 'V1', stopId: 'A', time: '07:59' },
    { action: 'arrived', vehicleId: 'V1', stopId: 'B', time: '08:06' },
    { action: 'completed', vehicleId: 'V2', stopId: 'A', time: '11:00' },
  ];
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries, events, vehicleId: 'V1' });
  assert.equal(plan.deliveries[2].preciseTimeText, '08:10');
  assert.equal(plan.finishText, '08:14');
  assert.equal(plan.timing.remainingMinutes, 8);
  assert.equal(plan.timing.lastArrivalText, '08:10');
});

test('자정 이후 예상과 실제 시각을 다음날로 표시한다', () => {
  const deliveries = [stop('A', [127, 37.5], { status: 'done', completedAt: '23:58' }), stop('B', [127, 37.5])];
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries });
  assert.equal(plan.deliveries[1].preciseTimeText, '23:58');
  assert.equal(plan.finishText, '다음날 00:02');
  const done = sourceViewerPlan({ date: '2026-09-16', deliveries: [
    deliveries[0], stop('B', [127, 37.5], { status: 'done', completedAt: '00:10' }),
  ] });
  assert.equal(done.finishText, '다음날 00:10');
});

test('제공된 ETA와 고객 시간 범위는 운영 계획보다 우선한다', () => {
  const delivery = stop('A', [127, 37.5], {
    calculatedEta: '08:15', preciseTimeText: '08:15', customerWindowStart: '08:00', customerWindowEnd: '09:00', customerWindowText: '08:00 ~ 09:00', etaSource: 'provider',
  });
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [delivery] });
  assert.equal(plan.deliveries[0].calculatedEta, '08:15');
  assert.equal(plan.deliveries[0].customerWindowText, '08:00 ~ 09:00');
  assert.equal(plan.deliveries[0].etaSource, 'provider');
  assert.equal(plan.finishText, '08:19');
});

test('부분 제공된 고객 범위는 보존하고 계획으로 비어 있는 ETA만 채운다', () => {
  const delivery = stop('A', [127, 37.5], { customerWindowText: '고객 협의 시간' });
  const first = sourceViewerPlan({ date: '2026-09-16', deliveries: [delivery] });
  assert.equal(first.deliveries[0].customerWindowText, '고객 협의 시간');
  assert.equal(first.deliveries[0].preciseTimeText, '06:50');
  const second = sourceViewerPlan({ date: '2026-09-16', deliveries: first.deliveries });
  assert.equal(second.deliveries[0].customerWindowText, '고객 협의 시간');
  assert.equal(second.deliveries[0].preciseTimeText, '06:50');
});

test('전체 완료 시각이 일부만 있으면 최종 완료로 확정하지 않는다', () => {
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [
    stop('A', [127, 37.5], { status: 'done', completedAt: '07:10' }),
    stop('B', [127, 37.5], { status: 'done' }),
  ] });
  assert.equal(plan.finishText, '완료 시각 미수신');
  assert.equal(plan.timing.completionMs, null);
});

test('빈 배차는 출발 시각을 완료 예상으로 사용하지 않는다', () => {
  const plan = sourceViewerPlan({ date: '2026-09-16', deliveries: [] });
  assert.equal(plan.finishText, '배차 없음');
  assert.equal(plan.timing.completionMs, null);
});

test('유효하지 않은 운영일은 입력을 그대로 반환한다', () => {
  const deliveries = [stop('A', [127, 37.5])];
  for (const date of ['invalid', '2026-02-31']) {
    const plan = sourceViewerPlan({ date, deliveries });
    assert.equal(plan.deliveries, deliveries);
    assert.equal(plan.timing, null);
  }
});

test('운송 조건은 제공값, 상품 명시, 운영 기본 순서로 결정한다', () => {
  assert.equal(transportConditionText({ transportConditions: [{ label: '상온 유지' }, '파손 주의'] }), '상온 유지 / 파손 주의');
  assert.equal(transportConditionText({ items: [{ name: '냉장 한우' }, { opt: '냉동 보관' }] }), '냉장 운송 / 냉동 운송');
  assert.equal(transportConditionText({ items: [] }), '보냉 운송 / 포장 상태 확인');
  const planned = sourceViewerPlan({ date: '2026-09-16', deliveries: [stop('A', [127, 37.5], { items: [] })] });
  assert.equal(planned.deliveries[0].transportConditionSource, 'operating-default');
  assert.deepEqual(planned.deliveries[0].items, []);
});
