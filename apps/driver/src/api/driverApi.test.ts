import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { fetchEvent, fetchHistory, fetchVehicles, pollRoute, saveTip, sendLocations, fetchRoute, fetchStop, sendStopEvent, uploadPhoto, newEventId, newEventStamp, photoUrl, sendDeparted, sendRouteReordered, suggestRoute } from './driverApi';
import { ApiError } from './types';

const DATE = '2026-11-02';
const NOW = '2026-11-02T00:30:00.000Z';
const route = {
  date: DATE, vehicleId: 'G1', revision: 8, phase: 'idle', dispatchPhase: 'published', operable: true,
  vehicle: { vehicleId: 'G1', label: '기사', plate: null, region: null },
  stops: [
    {
      stopId: 'O1', sequence: 1, orderIds: ['O1', 'O2'], name: '가게A', address: '서울', boxes: 2, status: 'pending', eta: null, estimated: null,
      coordinates: [127.01, 37.5],
      orders: [
        { orderId: 'O1', status: 'pending', orderNumber: 'N1', name: '가게A', address: '서울', detailAddress: null, boxes: 1, items: [{ sku: 'S1', name: '삼겹살', qty: 3, barcode: '8801234567890' }], customerRequests: null, tip: null, transportConditions: null, access: null, deliveryType: 'fresh', csNote: null },
        { orderId: 'O2', status: 'pending', orderNumber: 'N2', name: '가게A', address: '서울', detailAddress: null, boxes: 1, items: [], customerRequests: null, tip: null, transportConditions: null, access: null, deliveryType: null, csNote: null },
      ],
    },
    {
      stopId: 'O3', sequence: 2, orderIds: ['O3'], name: '가게B', address: '서울 2', boxes: 1, status: 'pending', eta: '2026-11-02T09:40:00+09:00', estimated: false,
      coordinates: null,
      orders: [
        { orderId: 'O3', status: 'pending', orderNumber: 'N3', name: '가게B', address: '서울 2', detailAddress: null, boxes: 1, items: null, customerRequests: null, tip: null, transportConditions: null, access: null, deliveryType: null, csNote: null },
      ],
    },
  ],
  next: { stopId: 'O1', eta: null },
};
const { sequence: _position, orders: _orders, ...stopSummary } = route.stops[0];
const detail = {
  ...stopSummary, assignmentUnitId: 'U1',
  orders: [{ orderId: 'O1', status: 'pending', orderNumber: 'N1', name: '가게A', address: '서울', detailAddress: null, boxes: 2, items: [], customerRequests: ['문 앞'], tip: null, transportConditions: null, access: null }],
  previousPhoto: { photoId: 'p1', date: '2026-11-01', completedAt: '2026-11-01T10:00:00+09:00' },
};
const suggestion = {
  date: DATE, vehicleId: 'G1', revision: 8, stopOrder: ['O3', 'O1'], changed: true, totalMinutes: 30, totalKm: 4.2,
  placed: [{ stopId: 'O3', placed: 'no-coordinates', afterStopId: null }],
};

type Call = { path: string; init: RequestInit };
function mockFetch(t: TestContext, respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const call = { path: new URL(url).pathname + new URL(url).search, init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const problem = (status: number, code: string) => new Response(JSON.stringify({ status, code }), {
  status, headers: { 'Content-Type': 'application/problem+json' },
});

test('reads route, stop detail and a suggestion from the driver endpoints with cookie and Origin', async (t) => {
  const calls = mockFetch(t, ({ path }) => json(
    path.includes('/route/suggest') ? suggestion : path.includes('/stops/') ? detail : route,
  ));
  assert.equal((await fetchRoute(DATE, 'G 1')).stops[1].estimated, false);
  const stop = await fetchStop(DATE, 'G1', 'O1');
  assert.equal(stop.previousPhoto?.photoId, 'p1');
  assert.equal(stop.sequence, null);
  const proposed = await suggestRoute(DATE, 'G1');
  assert.deepEqual(proposed.stopOrder, ['O3', 'O1']);
  await suggestRoute(DATE, 'G1', 'O1');
  assert.deepEqual(calls.map((call) => call.path), [
    `/api/dispatch-data/days/${DATE}/driver/route?vehicleId=G%201`,
    `/api/dispatch-data/days/${DATE}/driver/stops/O1?vehicleId=G1`,
    `/api/dispatch-data/days/${DATE}/driver/route/suggest?vehicleId=G1`,
    `/api/dispatch-data/days/${DATE}/driver/route/suggest?vehicleId=G1`,
  ]);
  assert.equal(calls.every(({ init }) => init.credentials === 'include' && new Headers(init.headers).has('Origin')), true);
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].init.body, undefined);
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { lockFirst: 'O1' });
});

test('sends departed and route_reordered events with the eventId, location and expected revision', async (t) => {
  const calls = mockFetch(t, () => json({ accepted: true, duplicate: false, receivedAt: 'now', next: { stopId: 'O3', eta: '2026-11-02T09:40:00+09:00' } }));
  const input = { eventId: 'e-1', occurredAt: '2026-11-02T00:30:00.000Z', date: DATE, vehicleId: 'G1', location: { lat: 37.5, lng: 127, accuracyM: 8 } };
  const departed = await sendDeparted(input);
  assert.equal(departed.next?.stopId, 'O3');
  await sendRouteReordered({ eventId: 'e-2', occurredAt: NOW, date: DATE, vehicleId: 'G1' }, ['O3', 'O1'], 8);
  const [first, second] = calls.map((call) => JSON.parse(String(call.init.body)));
  assert.deepEqual(first, {
    eventId: 'e-1', type: 'departed', occurredAt: input.occurredAt, date: DATE, vehicleId: 'G1', payload: {}, location: input.location,
  });
  assert.deepEqual(second.payload, { stopOrder: ['O3', 'O1'], expectedRevision: 8 });
  assert.equal('location' in second, false);
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/events`);
});

test('a resent event reports duplicate and a problem+json code reaches the caller', async (t) => {
  mockFetch(t, () => json({ accepted: true, duplicate: true, receivedAt: 'now' }, 202));
  const again = await sendDeparted({ eventId: 'e-1', occurredAt: NOW, date: DATE, vehicleId: 'G1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.next, null);

  for (const [status, code] of [[409, 'REVISION_CONFLICT'], [409, 'ROUTE_LOCKED'], [404, 'STOP_NOT_FOUND'], [401, 'LOGIN_REQUIRED']] as const) {
    t.mock.restoreAll();
    mockFetch(t, () => problem(status, code));
    await assert.rejects(
      sendRouteReordered({ eventId: 'e-3', occurredAt: NOW, date: DATE, vehicleId: 'G1' }, ['O1'], 1),
      (error: unknown) => error instanceof ApiError && error.status === status && error.code === code,
    );
  }
});

test('a resend carries the same body byte for byte, and a new stamp has its own ID and time', async (t) => {
  const calls = mockFetch(t, () => json({ accepted: true, duplicate: false, receivedAt: 'now' }, 202));
  const stamp = newEventStamp({ lat: 37.5, lng: 127 });
  const input = { ...stamp, date: DATE, vehicleId: 'G1' };
  await sendDeparted(input);
  await sendDeparted(input);
  assert.equal(calls[0].init.body, calls[1].init.body);
  const other = newEventStamp();
  assert.notEqual(other.eventId, stamp.eventId);
  assert.equal(Number.isFinite(Date.parse(other.occurredAt)), true);
  assert.equal(other.location, null);
});

test('malformed driver responses are rejected instead of shown', async (t) => {
  mockFetch(t, () => json({ ...route, stops: [{ ...route.stops[0], status: 'lost' }] }));
  await assert.rejects(fetchRoute(DATE, 'G1'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
  t.mock.restoreAll();
  mockFetch(t, () => json({ accepted: false }));
  await assert.rejects(sendDeparted({ eventId: 'e', occurredAt: NOW, date: DATE, vehicleId: 'G1' }), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
  t.mock.restoreAll();
  mockFetch(t, () => json({ ...suggestion, stopOrder: [1] }));
  await assert.rejects(suggestRoute(DATE, 'G1'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('event ids are unique, server-valid, and photo URLs stay on the dated driver path', () => {
  const ids = new Set(Array.from({ length: 50 }, newEventId));
  assert.equal(ids.size, 50);
  assert.equal([...ids].every((id) => /^[A-Za-z0-9_-]{1,64}$/u.test(id)), true);
  assert.match(photoUrl(DATE, 'p 1'), new RegExp(`/api/dispatch-data/days/${DATE}/driver/photos/p%201$`, 'u'));
});

test('uploads a photo as multipart without a hand-set content type and reads the receipt', async (t) => {
  const calls = mockFetch(t, () => json({ photoId: 'p-1', bytes: 321 }, 201));
  const receipt = await uploadPhoto(DATE, 'file:///data/outbox/e-1/0.jpg');
  assert.deepEqual(receipt, { photoId: 'p-1', bytes: 321 });
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/photos`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body instanceof FormData, true);
  assert.equal(new Headers(calls[0].init.headers).has('Content-Type'), false);
  assert.equal(new Headers(calls[0].init.headers).has('Origin'), true);
  t.mock.restoreAll();
  mockFetch(t, () => problem(413, 'PHOTO_TOO_LARGE'));
  await assert.rejects(uploadPhoto(DATE, 'file:///x.jpg'), (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'PHOTO_TOO_LARGE');
});

test('stop events go to the events endpoint with their payload and the stamped body', async (t) => {
  const calls = mockFetch(t, () => json({ accepted: true, duplicate: false, receivedAt: 'now', next: null }, 202));
  const input = { eventId: 'e-9', occurredAt: NOW, date: DATE, vehicleId: 'G1' };
  await sendStopEvent('stop_failed', input, { stopId: 'O1', reasonCode: 'ABSENT', photoIds: ['p-1'] });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    eventId: 'e-9', type: 'stop_failed', occurredAt: NOW, date: DATE, vehicleId: 'G1',
    payload: { stopId: 'O1', reasonCode: 'ABSENT', photoIds: ['p-1'] },
  });
});

test('a lost answer is looked up: the stored reply when the server saw the event, null when it did not', async (t) => {
  mockFetch(t, () => json({ accepted: true, duplicate: true, receivedAt: 'now', next: null }));
  assert.equal((await fetchEvent(DATE, 'e-1'))?.duplicate, true);
  t.mock.restoreAll();
  const calls = mockFetch(t, () => problem(404, 'REQUEST_NOT_FOUND'));
  assert.equal(await fetchEvent(DATE, 'e-2'), null);
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/events/e-2`);
  t.mock.restoreAll();
  mockFetch(t, () => problem(429, 'DRIVER_RATE_LIMITED'));
  await assert.rejects(fetchEvent(DATE, 'e-3'), (error: unknown) => error instanceof ApiError && error.status === 429);
});

test('the day history lists results with their reasons and photos', async (t) => {
  mockFetch(t, () => json({ date: DATE, vehicleId: 'G1', items: [
    { stopId: 'O1', result: 'failed', completedAt: '2026-11-02T10:00:00+09:00', reasonCode: 'ABSENT', note: '부재', photoIds: ['p-1'] },
    { stopId: 'O3', result: 'completed', completedAt: null },
  ] }));
  const items = await fetchHistory(DATE, 'G1');
  assert.deepEqual(items.map((item) => [item.stopId, item.result, item.reasonCode, item.photoIds]), [['O1', 'failed', 'ABSENT', ['p-1']], ['O3', 'completed', null, []]]);
  t.mock.restoreAll();
  mockFetch(t, () => json({ items: [{ stopId: 'O1', result: 'lost' }] }));
  await assert.rejects(fetchHistory(DATE, 'G1'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('a location batch goes to the locations endpoint with the vehicle and its samples', async (t) => {
  const calls = mockFetch(t, () => json({ accepted: 2, retained: 2, receivedAt: 'now' }, 202));
  const samples = [{ at: NOW, lat: 37.5, lng: 127, accuracyM: 8 }, { at: '2026-11-02T00:31:00.000Z', lat: 37.51, lng: 127.01 }];
  await sendLocations(DATE, 'G1', samples);
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/locations`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { vehicleId: 'G1', samples });
  t.mock.restoreAll();
  mockFetch(t, () => problem(409, 'DRIVER_DATE_READ_ONLY'));
  await assert.rejects(sendLocations(DATE, 'G1', samples), (error: unknown) => error instanceof ApiError && error.code === 'DRIVER_DATE_READ_ONLY');
});

test('a tip is posted with the vehicle, a request ID and the text, and a refusal reaches the caller', async (t) => {
  const calls = mockFetch(t, () => json({ accepted: true, duplicate: false, stopId: 'O1', tip: { body: '뒷문 이용', author: '기사', updatedAt: 'x' } }));
  assert.deepEqual(await saveTip(DATE, 'G1', 'O 1', 'req-1', '뒷문 이용'), { duplicate: false, body: '뒷문 이용' });
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/stops/O%201/tip`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { vehicleId: 'G1', requestId: 'req-1', body: '뒷문 이용' });
  t.mock.restoreAll();
  mockFetch(t, () => problem(409, 'OPERATION_REVISION_CONFLICT'));
  await assert.rejects(saveTip(DATE, 'G1', 'O1', 'req-2', '팁'), (error: unknown) => error instanceof ApiError && error.status === 409);
  t.mock.restoreAll();
  mockFetch(t, () => json({ accepted: true }));
  await assert.rejects(saveTip(DATE, 'G1', 'O1', 'req-3', '팁'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('a route poll sends the last ETag, takes a 304 as unchanged and keeps the new ETag of a changed route', async (t) => {
  const calls = mockFetch(t, ({ init }) => (new Headers(init.headers).get('If-None-Match') === 'W/"route-1"'
    ? new Response(null, { status: 304 })
    : new Response(JSON.stringify(route), { headers: { ETag: 'W/"route-2"' } })));
  assert.deepEqual(await pollRoute(DATE, 'G1', 'W/"route-1"'), { notModified: true });
  const changed = await pollRoute(DATE, 'G1', null);
  assert.equal(changed.notModified, false);
  if (!changed.notModified) {
    assert.equal(changed.etag, 'W/"route-2"');
    assert.equal(changed.route.stops[0].orders[0].items?.[0].barcode, '8801234567890');
    assert.deepEqual(changed.route.stops[0].coordinates, [127.01, 37.5]);
    assert.equal(changed.route.vehicle.label, '기사');
    assert.equal(changed.route.operable, true);
  }
  assert.equal(new Headers(calls[0].init.headers).get('If-None-Match'), 'W/"route-1"');
  assert.equal(new Headers(calls[1].init.headers).has('If-None-Match'), false);
});

test('the vehicle list is read with its counts, and a malformed one is refused', async (t) => {
  const row = { vehicleId: 'G1', label: '기사', plate: null, region: '서울', phase: 'idle', stops: 3, orders: 4 };
  const calls = mockFetch(t, () => json({ date: DATE, dispatchPhase: 'published', operable: true, vehicles: [row] }));
  const list = await fetchVehicles(DATE);
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/vehicles`);
  assert.deepEqual(list.vehicles, [row]);
  assert.equal(list.operable, true);
  t.mock.restoreAll();
  mockFetch(t, () => json({ date: DATE, dispatchPhase: 'published', operable: true, vehicles: [{ ...row, phase: 'lost' }] }));
  await assert.rejects(fetchVehicles(DATE), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});
