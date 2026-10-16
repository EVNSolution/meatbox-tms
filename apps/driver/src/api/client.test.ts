import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchDayState, fetchMessages, getSession, registerPushToken, revokePushToken, sendMessage } from './client';
import { readDayState } from './contracts';
import { ApiError } from './types';

const snapshot = {
  boot: 'server-boot', revision: 3, sourceData: { date: '2026-10-14' }, dispatch: { phase: 'published' },
  fleetVehicles: [{ id: 'v1', driver: '배송원' }],
  fleetDeliveries: [{ id: 'o1', vehicleId: 'v1', name: '정육점', address: '서울', sequence: 1, boxes: 2, coordinates: [127, 37], status: 'current', arrivedAt: '10:30', completedAt: null }],
  vehicleStates: { v1: { phase: 'delivering', truck: { dwelling: true, atStopId: 'o1' } } },
};

test('native API contracts use cookie credentials, same origin and date-scoped endpoints', async (t) => {
  const calls: { path: string; init: RequestInit }[] = [];
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, init });
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const body = path === '/api/session' ? { user: { username: 'driver', displayName: '배송원' } }
      : path.endsWith('/state') ? snapshot
      : path.includes('/messages?') ? { messages: [{ id: 'm1', from: 'ops', body: '배차 확인', createdAt: '2026-10-14T01:00:00Z' }] }
      : {};
    return new Response(JSON.stringify(body), { headers: { ETag: '"r3"' } });
  });
  assert.equal((await getSession())?.username, 'driver');
  const state = await fetchDayState('2026-10-14', '"r2"');
  assert.equal(state.notModified, false);
  await registerPushToken({ date: '2026-10-14', vehicleId: 'v1', token: 'fcm', deviceId: 'android', platform: 'android' });
  await revokePushToken('2026-10-13', 'old-fcm');
  assert.equal((await fetchMessages('2026-10-14', 'v 1'))[0].body, '배차 확인');
  await sendMessage('2026-10-14', 'v1', '출발합니다');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/session', '/api/dispatch-data/days/2026-10-14/state',
    '/api/dispatch-data/days/2026-10-14/driver/push-token', '/api/dispatch-data/days/2026-10-13/driver/push-token',
    '/api/dispatch-data/days/2026-10-14/driver/messages?vehicleId=v%201', '/api/dispatch-data/days/2026-10-14/driver/messages',
  ]);
  assert.equal(calls.every(({ init }) => init.credentials === 'include' && new Headers(init.headers).has('Origin')), true);
  assert.equal(new Headers(calls[1].init.headers).get('If-None-Match'), '"r2"');
  assert.deepEqual(bodies, [
    { vehicleId: 'v1', token: 'fcm', deviceId: 'android', platform: 'android' }, { token: 'old-fcm' },
    { vehicleId: 'v1', body: '출발합니다', from: 'driver' },
  ]);
});

test('session expiry and conditional state reads are explicit, errors never produce a mock state', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(null, { status: url.endsWith('/api/session') ? 401 : 304 }));
  assert.equal(await getSession(), null);
  assert.deepEqual(await fetchDayState('2026-10-14', '"r3"'), { notModified: true });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'REVISION_CONFLICT' }), { status: 409 }));
  await assert.rejects(fetchDayState('2026-10-14', null), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'REVISION_CONFLICT');
});

test('state accepts Kotlin clock strings and rejects wrong status, revision or session-shaped bodies', () => {
  assert.equal(readDayState(snapshot).fleetDeliveries[0].arrivedAt, '10:30');
  assert.throws(() => readDayState({ ...snapshot, revision: '3' }));
  assert.throws(() => readDayState({ ...snapshot, fleetDeliveries: [{ ...snapshot.fleetDeliveries[0], status: 'arrived' }] }));
  assert.throws(() => readDayState({ ...snapshot, fleetDeliveries: [{ ...snapshot.fleetDeliveries[0], arrivedAt: 123 }] }));
  assert.throws(() => readDayState({ user: { username: 'driver' } }));
});
