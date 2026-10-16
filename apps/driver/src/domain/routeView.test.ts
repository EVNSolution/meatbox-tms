import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DriverRoute, StopDetail } from '../api/driverContracts';
import { groupStops, type FleetDelivery } from './dispatch';
import { detailSections, dimmedStopKeys, etaLabel, serverStop } from './routeView';

const delivery = (id: string, name: string, status: FleetDelivery['status'] = 'pending'): FleetDelivery => ({
  id, vehicleId: 'G1', name, address: `${name} 주소`, boxes: 1, sequence: Number(id.slice(1)), status, coordinates: [127, 37.5],
});
const stops = groupStops([delivery('O1', 'A'), delivery('O2', 'A'), delivery('O3', 'B'), delivery('O4', 'C', 'done')]);
const route = (overrides: Partial<DriverRoute['stops'][number]>[]): DriverRoute => ({
  date: '2026-11-02', vehicleId: 'G1', revision: 4, phase: 'delivering', next: null,
  dispatchPhase: 'published', operable: true, vehicle: { vehicleId: 'G1', label: null, plate: null, region: null },
  stops: ['O1', 'O3', 'O4'].map((stopId, index) => ({
    stopId, sequence: index + 1, orderIds: stopId === 'O1' ? ['O1', 'O2'] : [stopId], name: stopId, address: '',
    boxes: 1, status: 'pending', eta: '2026-11-02T09:40:00+09:00', estimated: true, coordinates: null, orders: [], ...overrides[index],
  })),
});

test('a stop is matched to the server stop that holds its first order', () => {
  assert.equal(serverStop(stops[0], route([]))?.stopId, 'O1');
  assert.equal(serverStop(stops[1], route([]))?.stopId, 'O3');
  assert.equal(serverStop(stops[0], null), null);
});

test('the ETA shows the Seoul clock, is dimmed without travel time, and is absent before departure or when done', () => {
  assert.deepEqual(etaLabel(stops[0], route([])), { text: '도착 09:40', dimmed: false });
  assert.deepEqual(etaLabel(stops[0], route([{ eta: '2026-11-02T00:40:00Z' }])), { text: '도착 09:40', dimmed: false });
  assert.deepEqual(etaLabel(stops[1], route([{}, { estimated: false }])), { text: '09:40 · 이동 시간 미반영', dimmed: true });
  assert.equal(etaLabel(stops[0], route([{ eta: null, estimated: null }])), null);
  assert.equal(etaLabel(stops[0], route([{ eta: 'garbage' }])), null);
  assert.equal(etaLabel(stops[2], route([])), null);
  assert.equal(etaLabel(stops[0], null), null);
});

test('only stops without a travel time are dimmed on the map', () => {
  const keys = dimmedStopKeys(stops, route([{}, { estimated: false }]));
  assert.deepEqual([...keys], [stops[1].key]);
});

test('detail sections list requests, tip, access, transport and items, and skip empty ones', () => {
  const detail = {
    orders: [
      {
        orderId: 'O1', status: 'pending', orderNumber: null, name: null, address: null, detailAddress: null, boxes: 1,
        items: [{ sku: 'S1', name: '삼겹살', qty: 3 }, { sku: 'S2', qty: 1 }],
        customerRequests: { source: 'x', items: [{ label: '오전 배송', required: true }] },
        tip: { body: '뒷문 이용', author: '김기사', updatedAt: null },
        transportConditions: ['보냉 운송'],
        access: { entranceCode: '1234*', placeNote: '뒷문 냉장고 앞' },
      },
      {
        orderId: 'O2', status: 'pending', orderNumber: null, name: null, address: null, detailAddress: null, boxes: 1,
        items: [], customerRequests: ['오전 배송'], tip: null, transportConditions: ['보냉 운송'], access: null,
      },
    ],
  } as unknown as StopDetail;
  assert.deepEqual(detailSections(detail), [
    { title: '고객 요청', lines: ['오전 배송'] },
    { title: '배송팁', lines: ['뒷문 이용 (김기사)'] },
    { title: '출입 정보', lines: ['출입 코드 1234*', '뒷문 냉장고 앞'] },
    { title: '운송 조건', lines: ['보냉 운송'] },
    { title: '품목', lines: ['삼겹살 × 3', 'S2 × 1'] },
  ]);
  const bare = { orders: [{ ...detail.orders[0], items: null, customerRequests: null, tip: null, transportConditions: null, access: null }] } as unknown as StopDetail;
  assert.deepEqual(detailSections(bare), []);
});
