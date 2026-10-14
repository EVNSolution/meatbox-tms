import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouteOrderCommand, currentStopAction, groupStops, isCoordinate, isDispatchOperable, seoulToday, stopKey, type FleetDelivery, type DayState } from './dispatch';
import { matchPickupQr } from './pickupQr';
import { parsePushData } from './push';

function order(id: string, sequence: number, name = id, status: FleetDelivery['status'] = 'pending'): FleetDelivery {
  return { id, sequence, name, address: '서울', vehicleId: 'v1', boxes: 2, status, coordinates: [127, 37] };
}

test('Kotlin destination bundle key uses NFC+trim, ignores assignmentUnitId and isolates unnamed orders', () => {
  const first = { ...order('a', 1, ' 가게 '), assignmentUnitId: 'u1' };
  const second = { ...order('b', 2, '가게'), assignmentUnitId: 'u2' };
  assert.equal(stopKey(first), stopKey(second));
  assert.notEqual(stopKey(order('c', 3, '가  게')), stopKey(order('d', 4, '가 게')));
  assert.notEqual(stopKey(order('a', 1, '')), stopKey(order('b', 2, '')));
  const stops = groupStops([order('c', 3), second, first]);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].boxes, 4);
  assert.deepEqual(stops.map((stop) => stop.sequence), [1, 2]);
});

test('only current arrived stop can complete; skipped is never actionable', () => {
  const stop = groupStops([order('a', 1, '상점', 'current')])[0];
  assert.equal(currentStopAction(stop), 'arrive');
  const arrived = groupStops([{ ...order('a', 1, '상점', 'current'), arrivedAt: '10:35' }])[0];
  assert.equal(currentStopAction(arrived), 'complete');
  assert.equal(currentStopAction(groupStops([order('a', 1, '상점', 'skipped')])[0]), null);
});

test('route editing preserves current/done positions and all orders within each bundle', () => {
  const deliveries = [order('done', 1, '완료', 'done'), order('current', 2, '현재', 'current'), order('a1', 3, 'A'), order('a2', 4, 'A'), order('b', 5, 'B')];
  const keys = groupStops(deliveries).filter((stop) => stop.status === 'pending').map((stop) => stop.key).reverse();
  const command = buildRouteOrderCommand({ vehicleId: 'v1', deliveries, pendingStopKeys: keys, phase: 'delivering' });
  assert.deepEqual(command.order, ['done', 'current', 'b', 'a1', 'a2']);
  assert.deepEqual(command.expectedOrder, deliveries.map((value) => value.id));
  assert.throws(() => buildRouteOrderCommand({ vehicleId: 'v1', deliveries, pendingStopKeys: [keys[0], keys[0]], phase: 'delivering' }));
});

test('pending bundles cannot shift a protected order by changing bundle sizes', () => {
  const deliveries = [order('a1', 1, 'A'), order('a2', 2, 'A'), order('locked', 3, '보류', 'skipped'), order('b', 4, 'B')];
  const keys = groupStops(deliveries).filter((stop) => stop.status === 'pending').map((stop) => stop.key).reverse();
  assert.throws(() => buildRouteOrderCommand({ vehicleId: 'v1', deliveries, pendingStopKeys: keys, phase: 'delivering' }));
});

test('QR rejects wrong day, vehicle, unknown and repeat while keeping individual order identity', () => {
  const input = { date: '2026-10-14', vehicleOrderIds: new Set(['one', 'two']), allOrderIds: new Set(['one', 'two', 'other']), scanned: new Set(['one']) };
  const scan = (raw: string) => matchPickupQr({ ...input, raw });
  assert.equal(scan('meatbox:2026-10-14:two').kind, 'ok');
  assert.equal(scan('meatbox:2026-10-14:one').kind, 'already');
  assert.equal(scan('meatbox:2026-10-13:two').kind, 'wrong_date');
  assert.equal(scan('meatbox:2026-10-14:other').kind, 'other_vehicle');
  assert.equal(scan('meatbox:2026-10-14:unknown').kind, 'unknown');
  assert.equal(scan('not a qr').kind, 'invalid');
});

test('Seoul midnight advances date and invalid map coordinates never render as stops', () => {
  assert.equal(seoulToday(Date.parse('2026-10-13T14:59:59Z')), '2026-10-13');
  assert.equal(seoulToday(Date.parse('2026-10-13T15:00:00Z')), '2026-10-14');
  assert.equal(isCoordinate([181, 37]), false);
  assert.equal(isCoordinate([127, Number.NaN]), false);
  assert.equal(isCoordinate([127, 37]), true);
  assert.equal(isDispatchOperable({ dispatch: { phase: 'draft' } } as DayState), false);
  assert.equal(isDispatchOperable({ dispatch: { phase: 'amending' } } as DayState), true);
});

test('push payload requires date and vehicle, preserves scope and uses generic fallback', () => {
  assert.equal(parsePushData({ type: 'ops_message' }, {}, false), null);
  const push = parsePushData({ type: 'ops_message', date: '2026-10-14', vehicleId: 'v1', messageId: 'm1' }, { body: '새 메시지' }, true);
  assert.equal(push?.vehicleId, 'v1'); assert.equal(push?.date, '2026-10-14');
  assert.equal(push?.body, '새 메시지'); assert.equal(push?.tapped, true);
});
