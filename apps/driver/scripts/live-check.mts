// Runs the app's own API code (src/api, src/domain) against a running server: login -> route -> suggest ->
// route_reordered -> departed. It proves the contract between the app code and the server; it does not run the
// Android UI. Usage (fixture: node scripts/web-fork-fixture.mjs --native):
//   EXPO_PUBLIC_MEATBOX_API_BASE_URL=http://127.0.0.1:4173 LIVE_CHECK_USERNAME=... LIVE_CHECK_PASSWORD=... \
//     npx tsx scripts/live-check.mts
import assert from 'node:assert/strict';

const username = process.env.LIVE_CHECK_USERNAME ?? '';
const password = process.env.LIVE_CHECK_PASSWORD ?? '';
assert.ok(username && password, 'set LIVE_CHECK_USERNAME and LIVE_CHECK_PASSWORD');

// Node has no native cookie jar: keep Set-Cookie values and follow redirects by hand so the login cookie is kept.
const jar = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  let url = String(input);
  let method = init.method ?? 'GET';
  let body = init.body;
  for (let hop = 0; hop < 5; hop += 1) {
    const headers = new Headers(init.headers);
    if (jar.size > 0) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await realFetch(url, { ...init, method, body, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    url = new URL(location, url).toString();
    method = 'GET';
    body = undefined;
  }
  throw new Error('too many redirects');
}) as typeof fetch;

const { fetchDayState, login, sendCommand } = await import('../src/api/client');
const driverApi = await import('../src/api/driverApi');
const { ApiError } = await import('../src/api/types');
const { seoulToday, groupStops, vehicleDeliveries } = await import('../src/domain/dispatch');
const { detailSections, etaLabel } = await import('../src/domain/routeView');
const { suggestedKeys, serverStopOrder, suggestionSummary } = await import('../src/domain/routeDraft');

const date = seoulToday();
const vehicleId = process.env.LIVE_CHECK_VEHICLE ?? 'TRUCK-1';
const say = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

const user = await login(username, password);
say('login', { username: user.username });

// The operator confirms the day (web screen in production); the app never does this.
const open = await fetchDayState(date, null);
assert.ok(!open.notModified);
const phase = (open.state as unknown as { dispatch?: { phase?: string; draftVersion?: number } }).dispatch;
if (phase?.phase !== 'published') {
  const calculated = await sendCommand(date, open.state, { type: 'calculate_dispatch', vehicleIds: [vehicleId] } as never);
  assert.ok(calculated);
  await sendCommand(date, calculated, { type: 'publish_dispatch', draftVersion: (calculated as never as { dispatch: { draftVersion: number } }).dispatch.draftVersion } as never);
}

const before = await driverApi.fetchRoute(date, vehicleId);
say('route', { revision: before.revision, phase: before.phase, stops: before.stops.map((stop) => stop.stopId) });
assert.equal(before.phase, 'idle');
assert.ok(before.stops.length >= 2, 'the fixture needs two stops');
assert.ok(before.stops.every((stop) => stop.eta === null), 'no ETA before departure');

const stateAfterPublish = await fetchDayState(date, null);
assert.ok(!stateAfterPublish.notModified);
const stops = groupStops(vehicleDeliveries(stateAfterPublish.state, vehicleId));
const last = before.stops[before.stops.length - 1].stopId;
const suggestion = await driverApi.suggestRoute(date, vehicleId, last);
say('suggest', { lockFirst: last, stopOrder: suggestion.stopOrder, changed: suggestion.changed, summary: suggestionSummary(suggestion) });
assert.equal(suggestion.stopOrder[0], last);
assert.equal(suggestion.revision, before.revision);
assert.deepEqual((await driverApi.fetchRoute(date, vehicleId)).stops.map((stop) => stop.stopId), before.stops.map((stop) => stop.stopId), 'a suggestion changes nothing');

const keys = suggestedKeys(stops, suggestion, before);
assert.ok(keys, 'the editor can show the suggestion');
const order = serverStopOrder(keys, stops, before);
assert.deepEqual(order, suggestion.stopOrder);

const reorderStamp = driverApi.newEventStamp();
const reordered = await driverApi.sendRouteReordered({ ...reorderStamp, date, vehicleId }, order, before.revision);
say('route_reordered', { duplicate: reordered.duplicate });
assert.equal(reordered.duplicate, false);
const resent = await driverApi.sendRouteReordered({ ...reorderStamp, date, vehicleId }, order, before.revision);
assert.equal(resent.duplicate, true, 'a resend with the same eventId is a duplicate');
const after = await driverApi.fetchRoute(date, vehicleId);
assert.deepEqual(after.stops.map((stop) => stop.stopId), order);
say('route after reorder', { revision: after.revision, stops: after.stops.map((stop) => stop.stopId) });

await assert.rejects(
  driverApi.sendRouteReordered({ ...driverApi.newEventStamp(), date, vehicleId }, before.stops.map((stop) => stop.stopId), before.revision),
  (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'REVISION_CONFLICT',
);
say('stale revision', 'REVISION_CONFLICT');

const detail = await driverApi.fetchStop(date, vehicleId, after.stops[0].stopId);
say('stop detail', { sections: detailSections(detail), previousPhoto: detail.previousPhoto });

const departStamp = driverApi.newEventStamp({ lat: 37.5, lng: 126.9, accuracyM: 8 });
const departed = await driverApi.sendDeparted({ ...departStamp, date, vehicleId });
say('departed', { duplicate: departed.duplicate, next: departed.next });
assert.equal(departed.duplicate, false);
assert.ok(departed.next?.eta, 'the reply carries the first ETA');
assert.equal((await driverApi.sendDeparted({ ...departStamp, date, vehicleId })).duplicate, true);

const running = await driverApi.fetchRoute(date, vehicleId);
assert.equal(running.phase, 'delivering');
assert.ok(running.stops.every((stop) => stop.eta !== null), 'every open stop has an ETA after departure');
const latest = await fetchDayState(date, null);
assert.ok(!latest.notModified);
const running2 = groupStops(vehicleDeliveries(latest.state, vehicleId));
say('eta labels', running2.map((stop) => ({ name: stop.name, eta: etaLabel(stop, running) })));
await assert.rejects(
  driverApi.sendRouteReordered({ ...driverApi.newEventStamp(), date, vehicleId }, [...running.stops].reverse().map((stop) => stop.stopId), running.revision),
  (error: unknown) => error instanceof ApiError && error.status === 409,
);
say('reorder after departure', 'refused 409');
console.log('LIVE CHECK OK');
