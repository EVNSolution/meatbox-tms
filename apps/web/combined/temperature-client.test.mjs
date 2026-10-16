import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemperatureClient, dayWindow, TemperatureError } from './temperature-client.ts';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the day window is the Seoul day, ending now for today so that no future part is asked for', () => {
  const noon = Date.parse('2026-11-02T03:00:00Z');
  assert.deepEqual(dayWindow('2026-11-02', noon), { from: '2026-11-02T00:00:00+09:00', to: '2026-11-02T03:00:00.000Z' });
  assert.deepEqual(dayWindow('2026-11-01', noon), { from: '2026-11-01T00:00:00+09:00', to: '2026-11-02T00:00:00+09:00' });
  assert.deepEqual(dayWindow('2026-12-31', noon), { from: '2026-12-31T00:00:00+09:00', to: '2027-01-01T00:00:00+09:00' });
  assert.throws(() => dayWindow('2026-02-30'), /조회 날짜/);
  assert.throws(() => dayWindow('11/02'), /조회 날짜/);
});

test('latest and history call the telemetry routes with the session cookie and no caching', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).includes('/latest') ? json({ generatedAt: 'x', vehicles: [] })
      : json({ vehicleId: 'V 1', from: 'a', to: 'b', resolution: '1m', truncated: false, measurements: [{ sensorId: 'S1', measuredAt: '2026-11-02T09:00:00+09:00', celsius: -18.2, min: -18.4, max: -18, count: 6 }] });
  });
  const client = createTemperatureClient();
  assert.deepEqual(await client.latest(), []);
  const history = await client.history('V 1', '2026-11-01');
  assert.equal(history.measurements[0].count, 6);
  assert.equal(calls[0].url, '/api/telemetry/temperature/latest');
  const url = new URL(calls[1].url, 'http://x');
  assert.equal(url.pathname, '/api/telemetry/temperature/V%201');
  assert.deepEqual([...url.searchParams], [['from', '2026-11-01T00:00:00+09:00'], ['to', '2026-11-02T00:00:00+09:00'], ['resolution', '1m']]);
  assert.equal(calls.every(call => call.init.credentials === 'same-origin' && call.init.cache === 'no-store'), true);
});

test('a missing telemetry module is "unavailable", not "no data", and other failures keep their reason', async () => {
  for (const [status, unavailable] of [[404, true], [503, true], [401, false], [403, false], [500, false]]) {
    const client = createTemperatureClient(async () => json({ code: 'X' }, status));
    await assert.rejects(client.latest(), error => error instanceof TemperatureError && error.status === status && error.unavailable === unavailable);
  }
  const offline = createTemperatureClient(async () => { throw new TypeError('network'); });
  await assert.rejects(offline.latest(), error => error.status === 0 && /연결 상태/.test(error.message));
});

test('a history answer that does not match the contract is refused', async () => {
  const bad = body => createTemperatureClient(async () => json(body)).history('V1', '2026-11-01');
  await assert.rejects(bad({ vehicleId: 'V1', from: 'a', to: 'b', measurements: [{ sensorId: 'S', measuredAt: 'not a time', celsius: 1 }] }), /온도 응답/);
  await assert.rejects(bad({ vehicleId: 'V1', from: 'a', to: 'b', measurements: [{ sensorId: 'S', measuredAt: '2026-11-01T00:00:00+09:00', celsius: 'x' }] }), /온도 응답/);
  await assert.rejects(bad({ vehicleId: 'V1' }), /온도 응답/);
  await assert.rejects(createTemperatureClient(async () => json({})).history('', '2026-11-01'), /차량/);
});
