import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DriverRoute, RouteStop, StopOrderDetail } from '../api/driverContracts';
import { routeStops } from './routeStops';

const order = (orderId: string, extra: Partial<StopOrderDetail> = {}): StopOrderDetail => ({
  orderId, status: 'pending', orderNumber: `N-${orderId}`, name: `가게${orderId}`, address: `주소 ${orderId}`, detailAddress: '1층',
  boxes: 2, items: [{ sku: 'S1', qty: 1, barcode: '880' }], customerRequests: null, tip: null, transportConditions: null,
  access: null, deliveryType: null, csNote: null, ...extra,
});
const stop = (stopId: string, orders: StopOrderDetail[], extra: Partial<RouteStop> = {}): RouteStop => ({
  stopId, sequence: null, orderIds: orders.map((entry) => entry.orderId), name: orders[0].name ?? '', address: orders[0].address ?? '',
  boxes: 0, status: 'pending', eta: null, estimated: null, coordinates: [127.01, 37.5], orders, ...extra,
});
const route = (stops: RouteStop[]): DriverRoute => ({
  date: '2026-11-02', vehicleId: 'G1', revision: 3, phase: 'idle', dispatchPhase: 'published', operable: true,
  vehicle: { vehicleId: 'G1', label: '기사', plate: null, region: null }, stops, next: null,
});

test('one app stop per server stop, in route order, keyed by the server stop ID, with every order', () => {
  const stops = routeStops(route([
    stop('A1', [order('A1'), order('A2', { name: '가게A1', address: '주소 A1' })], { sequence: 1 }),
    stop('B1', [order('B1')], { sequence: 2 }),
  ]));
  assert.deepEqual(stops.map((entry) => [entry.key, entry.sequence, entry.orders.map((item) => item.id)]), [['A1', 1, ['A1', 'A2']], ['B1', 2, ['B1']]]);
  assert.equal(stops[0].boxes, 4);
  assert.deepEqual(stops[0].coordinates, [127.01, 37.5]);
  assert.equal(stops[0].detailAddress, '1층');
});

test('two stops with the same name and address stay two stops, because the server decides what a stop is', () => {
  const same = { name: '같은 가게', address: '같은 주소' };
  const stops = routeStops(route([stop('A1', [order('A1', same)]), stop('B1', [order('B1', same)])]));
  assert.deepEqual(stops.map((entry) => entry.key), ['A1', 'B1']);
});

test('order data reaches the stop: items with barcodes, status and a missing position', () => {
  const [first] = routeStops(route([stop('A1', [order('A1', { status: 'current' })], { coordinates: null, status: 'current' })]));
  assert.equal(first.status, 'current');
  assert.equal(first.coordinates, null);
  assert.equal(first.orders[0].items?.[0].barcode, '880');
  assert.equal(first.orders[0].vehicleId, 'G1');
});

test('a status the app does not know falls back to the stop status, and an empty route has no stops', () => {
  const [first] = routeStops(route([stop('A1', [order('A1', { status: 'weird' })], { status: 'done' })]));
  assert.equal(first.status, 'done');
  assert.deepEqual(routeStops(route([])), []);
});
