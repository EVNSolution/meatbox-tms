import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchMessages, getSession, registerPushToken, revokePushToken, sendMessage } from './client';
import { fetchRoute, pollRoute } from './driverApi';
import { ApiError } from './types';

test('native API contracts use cookie credentials, same origin and date-scoped endpoints', async (t) => {
  const calls: { path: string; init: RequestInit }[] = [];
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, init });
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const body = path === '/api/session' ? { user: { username: 'driver', displayName: '배송원' } }
      : path.includes('/messages?') ? { messages: [{ id: 'm1', from: 'ops', body: '배차 확인', createdAt: '2026-10-14T01:00:00Z' }] }
      : {};
    return new Response(JSON.stringify(body));
  });
  assert.equal((await getSession())?.username, 'driver');
  await registerPushToken({ date: '2026-10-14', vehicleId: 'v1', token: 'fcm', deviceId: 'android', platform: 'android' });
  await revokePushToken('2026-10-13', 'old-fcm');
  assert.equal((await fetchMessages('2026-10-14', 'v 1'))[0].body, '배차 확인');
  await sendMessage('2026-10-14', 'v1', '출발합니다');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/session',
    '/api/dispatch-data/days/2026-10-14/driver/push-token', '/api/dispatch-data/days/2026-10-13/driver/push-token',
    '/api/dispatch-data/days/2026-10-14/driver/messages?vehicleId=v%201', '/api/dispatch-data/days/2026-10-14/driver/messages',
  ]);
  assert.equal(calls.every(({ init }) => init.credentials === 'include' && new Headers(init.headers).has('Origin')), true);
  assert.deepEqual(bodies, [
    { vehicleId: 'v1', token: 'fcm', deviceId: 'android', platform: 'android' }, { token: 'old-fcm' },
    { vehicleId: 'v1', body: '출발합니다', from: 'driver' },
  ]);
});

test('session expiry is explicit and errors never produce a mock route', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(null, { status: url.endsWith('/api/session') ? 401 : 304 }));
  assert.equal(await getSession(), null);
  assert.deepEqual(await pollRoute('2026-10-14', 'v1', '"r3"'), { notModified: true });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 'DRIVER_VEHICLE_NOT_FOUND' }), { status: 404 }));
  await assert.rejects(fetchRoute('2026-10-14', 'v9'), (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === 'DRIVER_VEHICLE_NOT_FOUND');
});
