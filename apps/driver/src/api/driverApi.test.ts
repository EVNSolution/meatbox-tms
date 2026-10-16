import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { fetchRoute, fetchStop, newEventId, photoUrl, sendDeparted, sendRouteReordered, suggestRoute } from './driverApi';
import { ApiError } from './types';

const DATE = '2026-11-02';
const route = {
  date: DATE, vehicleId: 'G1', revision: 8, phase: 'idle',
  stops: [
    { stopId: 'O1', sequence: 1, orderIds: ['O1', 'O2'], name: '가게A', address: '서울', boxes: 2, status: 'pending', eta: null, estimated: null },
    { stopId: 'O3', sequence: 2, orderIds: ['O3'], name: '가게B', address: '서울 2', boxes: 1, status: 'pending', eta: '2026-11-02T09:40:00+09:00', estimated: false },
  ],
  next: { stopId: 'O1', eta: null },
};
const detail = {
  ...route.stops[0], assignmentUnitId: 'U1',
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
  assert.equal((await fetchStop(DATE, 'G1', 'O1')).previousPhoto?.photoId, 'p1');
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
  const input = { eventId: 'e-1', date: DATE, vehicleId: 'G1', location: { lat: 37.5, lng: 127, accuracyM: 8 } };
  const departed = await sendDeparted(input);
  assert.equal(departed.next?.stopId, 'O3');
  await sendRouteReordered({ eventId: 'e-2', date: DATE, vehicleId: 'G1' }, ['O3', 'O1'], 8);
  const [first, second] = calls.map((call) => JSON.parse(String(call.init.body)));
  assert.deepEqual({ ...first, occurredAt: typeof first.occurredAt }, {
    eventId: 'e-1', type: 'departed', occurredAt: 'string', date: DATE, vehicleId: 'G1', payload: {}, location: input.location,
  });
  assert.equal(Number.isFinite(Date.parse(first.occurredAt)), true);
  assert.deepEqual(second.payload, { stopOrder: ['O3', 'O1'], expectedRevision: 8 });
  assert.equal('location' in second, false);
  assert.equal(calls[0].path, `/api/dispatch-data/days/${DATE}/driver/events`);
});

test('a resent event reports duplicate and a problem+json code reaches the caller', async (t) => {
  mockFetch(t, () => json({ accepted: true, duplicate: true, receivedAt: 'now' }, 202));
  const again = await sendDeparted({ eventId: 'e-1', date: DATE, vehicleId: 'G1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.next, null);

  for (const [status, code] of [[409, 'REVISION_CONFLICT'], [409, 'ROUTE_LOCKED'], [404, 'STOP_NOT_FOUND'], [401, 'LOGIN_REQUIRED']] as const) {
    t.mock.restoreAll();
    mockFetch(t, () => problem(status, code));
    await assert.rejects(
      sendRouteReordered({ eventId: 'e-3', date: DATE, vehicleId: 'G1' }, ['O1'], 1),
      (error: unknown) => error instanceof ApiError && error.status === status && error.code === code,
    );
  }
});

test('malformed driver responses are rejected instead of shown', async (t) => {
  mockFetch(t, () => json({ ...route, stops: [{ ...route.stops[0], status: 'lost' }] }));
  await assert.rejects(fetchRoute(DATE, 'G1'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
  t.mock.restoreAll();
  mockFetch(t, () => json({ accepted: false }));
  await assert.rejects(sendDeparted({ eventId: 'e', date: DATE, vehicleId: 'G1' }), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
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
