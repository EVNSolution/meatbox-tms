// Runs the app's own API code (src/api, src/domain, src/outbox) against a running server: login -> route ->
// suggest -> route_reordered -> departed -> stop reports through the real device queue (photo upload, completion,
// failure, partial delivery, a lost answer) -> history. It proves the contract between the app code and the server; it does not run the
// Android UI. Usage (fixture: node scripts/web-fork-fixture.mjs --native):
//   EXPO_PUBLIC_MEATBOX_API_BASE_URL=http://127.0.0.1:4173 LIVE_CHECK_USERNAME=... LIVE_CHECK_PASSWORD=... \
//     LIVE_CHECK_PLAN=completed,failed npx tsx scripts/live-check.mts   (plan: result per stop, in route order;
//     completed | failed | partial; needs a fresh fixture each run)
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// React Native appends `{ uri, name, type }` to a FormData; Node needs the bytes, so read the file for it.
const NativeFormData = globalThis.FormData;
globalThis.FormData = class extends NativeFormData {
  append(name: string, value: unknown, fileName?: string) {
    const file = value as { uri?: string; name?: string; type?: string };
    if (file && typeof file === 'object' && !(value instanceof Blob) && typeof file.uri === 'string') {
      const bytes = readFileSync(fileURLToPath(file.uri));
      super.append(name, new Blob([bytes], { type: file.type }), file.name);
    } else {
      super.append(name, value as Blob, fileName);
    }
  }
} as typeof FormData;

const { fetchDayState, login } = await import('../src/api/client');
const driverApi = await import('../src/api/driverApi');
const { ApiError } = await import('../src/api/types');
const { seoulToday, groupStops, vehicleDeliveries } = await import('../src/domain/dispatch');
const { detailSections, etaLabel } = await import('../src/domain/routeView');
const { suggestedKeys, serverStopOrder, suggestionSummary } = await import('../src/domain/routeDraft');
const { buildStopEvent } = await import('../src/domain/stopEvents');
const { Outbox } = await import('../src/outbox/Outbox');

const date = seoulToday();
const vehicleId = process.env.LIVE_CHECK_VEHICLE ?? 'TRUCK-1';
const say = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

const user = await login(username, password);
say('login', { username: user.username });

// The operator confirms the day (web screen in production); the app never does this. Plain requests, not app code.
async function operatorCommand(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await fetchDayState(date, null);
  assert.ok(!current.notModified);
  const snapshot = current.state as unknown as { boot: string; revision: number; dispatch?: { draftVersion?: number } };
  const response = await fetch(`${process.env.EXPO_PUBLIC_MEATBOX_API_BASE_URL}/api/dispatch-data/days/${date}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(process.env.EXPO_PUBLIC_MEATBOX_API_BASE_URL as string).origin },
    body: JSON.stringify({ ...body, expectedBoot: snapshot.boot, expectedRevision: snapshot.revision, draftVersion: body.type === 'publish_dispatch' ? snapshot.dispatch?.draftVersion : undefined }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Record<string, unknown>;
}
const open = await fetchDayState(date, null);
assert.ok(!open.notModified);
if ((open.state as unknown as { dispatch?: { phase?: string } }).dispatch?.phase !== 'published') {
  await operatorCommand({ type: 'calculate_dispatch', vehicleIds: [vehicleId] });
  await operatorCommand({ type: 'publish_dispatch' });
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

// Stop reports through the app's own device queue. Its storage and clock are in memory; its network is the app's code.
const plan = (process.env.LIVE_CHECK_PLAN ?? 'completed,failed').split(',');
assert.ok(plan.length <= running.stops.length, 'the plan has more results than the route has stops');
const folder = mkdtempSync(join(tmpdir(), 'live-check-'));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const photoOf = (name: string) => { const path = join(folder, name); writeFileSync(path, jpeg); return pathToFileURL(path).toString(); };
let saved = '[]';
let clock = Date.now();
let lostOnce = plan.includes('completed');
const log: string[] = [];
const outbox = new Outbox({
  load: async () => JSON.parse(saved),
  save: async (items) => { saved = JSON.stringify(items); },
  now: () => clock,
  photoReady: (uri) => existsSync(fileURLToPath(uri)),
  uploadPhoto: async (day, uri) => { log.push('upload'); return driverApi.uploadPhoto(day, uri); },
  sendEvent: async (item, payload) => {
    log.push(`send ${item.type}`);
    const answer = await driverApi.sendStopEvent(item.type, item, payload);
    if (lostOnce && item.type === 'stop_completed') {
      // The server took the event but the answer never arrived.
      lostOnce = false;
      throw new TypeError('Network request failed');
    }
    return answer;
  },
  lookupEvent: async (day, eventId) => { log.push('lookup'); return driverApi.fetchEvent(day, eventId); },
  removePhotos: (item) => { for (const photo of item.photos) rmSync(fileURLToPath(photo.localPath), { force: true }); },
});
await outbox.init();
for (const [index, kind] of plan.entries()) {
  const stopId = running.stops[index].stopId;
  const draft = kind === 'completed' ? { kind: 'completed' as const, note: '문 앞 보관' }
    : kind === 'failed' ? { kind: 'failed' as const, reasonCode: 'ABSENT' as const, note: '부재' }
      : { kind: 'partial' as const, note: '일부 품절', items: [{ sku: 'LIVE-1', name: '시험 품목', orderedQty: 3, deliveredQty: 1 }] };
  const { type, payload } = buildStopEvent(stopId, draft, running.stops[index].orderIds[0]);
  const eventId = driverApi.newEventId();
  await outbox.enqueue({
    eventId, occurredAt: new Date().toISOString(), date, vehicleId, type, stopId, payload,
    photoPaths: kind === 'partial' ? [] : [photoOf(`${eventId}.jpg`)],
  });
}
const first = await outbox.drain();
say('queue after first drain', { result: first.kind, states: outbox.list().map((item) => item.state), log });
if (plan.includes('completed')) {
  assert.equal(first.kind, 'waiting', 'the lost answer makes the queue wait');
  clock += 5_000;
  log.length = 0;
  assert.equal((await outbox.drain()).kind, 'idle');
  say('queue after the retry', { log });
  assert.equal(log[0], 'lookup', 'a lost answer is looked up before anything is sent again');
} else {
  assert.equal(first.kind, 'idle');
}
assert.deepEqual(outbox.list().map((item) => item.state), plan.map(() => 'sent'));
assert.equal(outbox.list().every((item) => item.reply?.accepted === true), true);

const history = await driverApi.fetchHistory(date, vehicleId);
say('history', history.map((entry) => ({ stopId: entry.stopId, result: entry.result, reasonCode: entry.reasonCode, note: entry.note, photos: entry.photoIds.length })));
assert.deepEqual(history.map((entry) => entry.stopId), plan.map((_kind: string, index: number) => running.stops[index].stopId));
const expectedResult = { completed: 'completed', failed: 'failed', partial: 'partially_completed' } as const;
assert.deepEqual(history.map((entry) => entry.result), plan.map((kind: string) => expectedResult[kind as keyof typeof expectedResult]));

// The photo the server stored is the photo that was uploaded.
const withPhoto = history.find((entry) => entry.photoIds.length > 0);
if (withPhoto) {
  const photo = await fetch(driverApi.photoUrl(date, withPhoto.photoIds[0]));
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
  say('photo download', { bytes: jpeg.length, same: true });
}

// A resend of a finished event is answered as a duplicate and changes nothing.
const sentItem = outbox.list().find((item) => item.photos.length > 0) ?? outbox.list()[0];
const photoIds = sentItem.photos.map((photo) => photo.photoId);
const again = await driverApi.sendStopEvent(sentItem.type, sentItem, photoIds.length > 0 ? { ...sentItem.payload, photoIds } : sentItem.payload);
assert.equal(again.duplicate, true);
say('resend of a sent event', { duplicate: again.duplicate });
assert.equal((await driverApi.fetchEvent(date, 'never-sent'))?.accepted ?? null, null);
await outbox.pruneSent();
assert.equal(outbox.list().length, 0);
rmSync(folder, { recursive: true, force: true });
console.log('LIVE CHECK OK');
