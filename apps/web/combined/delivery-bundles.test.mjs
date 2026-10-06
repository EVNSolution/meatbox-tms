import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleDeliveries, destinationKey } from './delivery-bundles.mjs';

test('배송지 키는 NFC와 가장자리 공백을 정규화하고 불완전한 주소는 주문별로 분리한다', () => {
  assert.equal(destinationKey({ id: 'A', name: ' 카페\u0301 ', address: ' 서울 ' }), destinationKey({ id: 'B', name: '카페́', address: '서울' }));
  assert.notEqual(destinationKey({ id: 'A', name: '매장', address: '' }), destinationKey({ id: 'B', name: '매장', address: '' }));
});

test('같은 날짜와 차량의 동일 배송지를 원본 순서로 묶고 주문 사실을 모두 보존한다', () => {
  const input = [
    { id: 'O1', date: '2026-09-16', vehicleId: 'V1', name: ' 정육점 ', address: '서울', boxes: 2, status: 'done', completedAt: '07:10', notices: [{ id: 'N1', title: '출발' }], timeline: [{ label: '도착', time: '07:00', state: 'done' }], customerRequests: { source: 'source', items: [{ id: 'R1', required: true }] } },
    { id: 'O2', date: '2026-09-16', vehicleId: 'V1', name: '정육점', address: '서울', boxes: 3, status: 'current', arrivedAt: '07:12', notices: [{ id: 'N1', title: '출발' }, { id: 'N2', title: '도착' }], timeline: [{ label: '도착', time: '07:00', state: 'done' }], customerRequests: { source: 'source', items: [{ id: 'R2', required: true }] } },
    { id: 'O3', date: '2026-09-16', vehicleId: 'V2', name: '정육점', address: '서울', boxes: 4, status: 'pending' },
    { id: 'O4', date: '2026-09-17', vehicleId: 'V1', name: '정육점', address: '서울', boxes: 5, status: 'skipped' },
  ];
  const bundled = bundleDeliveries(input);
  assert.equal(bundled.length, 3);
  assert.deepEqual(bundled[0].orderIds, ['O1', 'O2']);
  assert.deepEqual(bundled[0].orders.map(order => order.id), ['O1', 'O2']);
  assert.equal(bundled[0].id, 'O1');
  assert.equal(bundled[0].boxes, 5);
  assert.equal(bundled[0].status, 'current');
  assert.equal(bundled[0].arrivedAt, '07:12');
  assert.deepEqual(bundled[0].notices.map(item => [item.id, item.sourceOrderId]), [['N1', 'O1'], ['N2', 'O2']]);
  assert.deepEqual(bundled[0].notices.map(item => item.stopId), ['O1', 'O1']);
  assert.deepEqual(bundled[0].timeline.map(item => item.sourceOrderId), ['O1']);
  assert.deepEqual(bundled[0].customerRequests.items.map(item => item.id), ['R1', 'R2']);
  assert.deepEqual(bundleDeliveries(bundled), bundled);
  assert.deepEqual(input.map(order => order.id), ['O1', 'O2', 'O3', 'O4']);
});

test('묶음 상태는 current, pending, skipped, 전체 done 순으로 집계한다', () => {
  const orders = statuses => statuses.map((status, index) => ({ id: `O${index}`, vehicleId: 'V1', name: 'A', address: 'B', boxes: 1, status }));
  assert.equal(bundleDeliveries(orders(['done', 'skipped']))[0].status, 'skipped');
  assert.equal(bundleDeliveries(orders(['skipped', 'pending']))[0].status, 'pending');
  assert.equal(bundleDeliveries(orders(['pending', 'current']))[0].status, 'current');
  assert.equal(bundleDeliveries(orders(['done', 'done']))[0].status, 'done');
});

test('대표 주문이 오래된 상태여도 현재 하위 주문의 고객 상태와 도착 사실을 사용한다', () => {
  const bundle = bundleDeliveries([
    { id: 'O1', vehicleId: 'V1', name: 'A', address: 'B', boxes: 1, status: 'done', arrivedAt: '07:00', completedAt: '07:04', customerStatus: { key: 'paid', label: '결제 완료' } },
    { id: 'O2', vehicleId: 'V1', name: 'A', address: 'B', boxes: 1, status: 'current', arrivedAt: '07:12', customerStatus: { key: 'arrived', label: '배송지 도착' }, customerStatusTone: 'blue' },
  ])[0];
  assert.equal(bundle.status, 'current');
  assert.deepEqual(bundle.customerStatus, { key: 'arrived', label: '배송지 도착' });
  assert.equal(bundle.customerStatusTone, 'blue');
  assert.equal(bundle.arrivedAt, '07:12');
  assert.equal(bundle.completedAt, null);
});

test('표시 순번은 날짜와 차량마다 묶음 단위로 연속이며 하위 주문 순번은 보존한다', () => {
  const bundled = bundleDeliveries([
    { id: 'O1', date: '2026-09-16', vehicleId: 'V1', name: 'A', address: '서울', boxes: 1, status: 'pending', sequence: 3 },
    { id: 'O2', date: '2026-09-16', vehicleId: 'V1', name: 'A', address: '서울', boxes: 1, status: 'pending', sequence: 10 },
    { id: 'O3', date: '2026-09-16', vehicleId: 'V2', name: 'C', address: '인천', boxes: 1, status: 'pending', sequence: 40 },
    { id: 'O4', date: '2026-09-16', vehicleId: 'V1', name: 'B', address: '부산', boxes: 1, status: 'pending', sequence: 11 },
    { id: 'O5', date: '2026-09-17', vehicleId: 'V1', name: 'D', address: '대전', boxes: 1, status: 'pending', sequence: 28 },
  ]);
  assert.deepEqual(bundled.map(stop => [stop.id, stop.sequence]), [['O1', 1], ['O3', 1], ['O4', 2], ['O5', 1]]);
  assert.deepEqual(bundled[0].orders.map(order => order.sequence), [3, 10]);
  assert.deepEqual(bundleDeliveries(bundled), bundled);
});

test('박스 수량 누락은 0으로 꾸미지 않는다', () => {
  assert.equal(bundleDeliveries([{ id: 'O1', vehicleId: 'V1', name: 'A', address: 'B', boxes: null, status: 'pending' }])[0].boxes, null);
  assert.equal(bundleDeliveries([
    { id: 'O1', vehicleId: 'V1', name: 'A', address: 'B', boxes: 2, status: 'pending' },
    { id: 'O2', vehicleId: 'V1', name: 'A', address: 'B', status: 'pending' },
  ])[0].boxes, null);
  assert.equal(bundleDeliveries([{ id: 'O1', vehicleId: 'V1', name: 'A', address: 'B', boxes: -1, status: 'pending' }])[0].boxes, null);
  assert.equal(bundleDeliveries([{ id: 'O1', vehicleId: 'V1', name: 'A', address: 'B', boxes: Number.NaN, status: 'pending' }])[0].boxes, null);
});
