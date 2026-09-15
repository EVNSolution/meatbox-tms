import test from 'node:test';
import assert from 'node:assert/strict';
import { connectSourceOperations, sourceDate } from './source-client.mjs';

const manifest = { schemaVersion: 1, defaultDate: '2025-09-12', dates: [{ date: '2025-09-12', weekday: '금요일' }, { date: '2025-09-13', weekday: '토요일' }] };
const response = (body, status = 200, etag = '"v1"') => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: name => name.toLowerCase() === 'etag' ? etag : null } });
const state = (date, revision = 1) => ({ boot: 'boot-1', revision, sourceData: { date, defaultVehicleId: 'G1' }, fleetDeliveries: [{ id: `O-${date}`, vehicleId: 'G1' }] });

function globals(t, fetchImpl) {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, history: globalThis.history, sessionStorage: globalThis.sessionStorage, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const events = new Map(); const stored = new Map();
  globalThis.fetch = fetchImpl; globalThis.location = { href: 'https://demo.test/combined/?id=O-2025-09-12', search: '' };
  globalThis.history = { replaceState() {} }; globalThis.sessionStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  globalThis.setTimeout = () => 1; globalThis.clearTimeout = () => {};
  t.after(() => Object.assign(globalThis, saved));
  return { events, stored };
}

test('날짜 목록은 기본 날짜로 안전하게 보정된다', () => {
  assert.equal(sourceDate(manifest, '없는 날짜'), manifest.defaultDate);
  assert.equal(sourceDate(manifest, '2025-09-13'), '2025-09-13');
});

test('원본 상태를 받고 명령에 boot와 revision을 포함하며 304에서는 기존 상태를 유지한다', async t => {
  const calls = []; const { stored } = globals(t, async (url, options = {}) => {
    calls.push([url, options]);
    if (url.endsWith('/state')) return calls.length === 1 ? response(state('2025-09-12')) : response(null, 304);
    return response({ state: state('2025-09-12', 2), result: { changedCount: 1 } }, 200, '"v2"');
  });
  const states = [], statuses = [], errors = [];
  const client = connectSourceOperations({ manifest, onState: value => states.push(value), onStatus: (...args) => statuses.push(args), onError: error => errors.push(error), login: () => errors.push('login') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.length, 1);
  assert.equal(stored.get('meatbox.dispatch.date'), '2025-09-12');
  const result = await client.send('assign_orders', { stopId: 'O-2025-09-12', targetVehicleId: 'G2' });
  assert.deepEqual(result, { changedCount: 1 });
  const command = JSON.parse(calls.find(item => item[0].endsWith('/commands'))[1].body);
  assert.equal(command.expectedRevision, 1); assert.equal(command.expectedBoot, 'boot-1');
  assert.equal(command.vehicleId, 'G1');
  await client.selectDate('2025-09-13');
  assert.ok(statuses.some(item => String(item[1]).includes('2025-09-13')));
  client.close(); assert.deepEqual(errors, []);
});

test('자료 서버 오류는 성공 상태나 레거시 상태로 흘러가지 않는다', async t => {
  const { events } = globals(t, async url => url.endsWith('/state') ? response({ message: 'failed' }, 500) : response(null, 404));
  const states = [], statuses = [];
  const client = connectSourceOperations({ manifest, onState: value => states.push(value), onStatus: (...args) => statuses.push(args), onError() {}, login() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, []); assert.match(statuses.at(-1)[1], /배송 상태/);
  client.close(); assert.equal(events.size, 0);
});

test('날짜 변경 중 늦게 도착한 이전 상태는 새 날짜를 덮어쓰지 않는다', async t => {
  const oldDay = deferredResponse();
  const newDay = deferredResponse();
  globals(t, async url => url.endsWith('2025-09-12/state') ? oldDay.promise : newDay.promise);
  const states = [];
  const client = connectSourceOperations({ manifest, onState: value => states.push(value), onStatus() {}, onError() {}, login() {} });
  const selecting = client.selectDate('2025-09-13');
  newDay.resolve(response(state('2025-09-13')));
  await selecting;
  oldDay.resolve(response(state('2025-09-12')));
  await oldDay.settled;
  assert.deepEqual(states.map(value => value.sourceData.date), ['2025-09-13']);
  client.close();
});

function deferredResponse() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve, settled: promise.then(() => undefined) };
}


test('과거 조회 상태에서는 운행 및 배차 명령을 전송하지 않는다', async t => {
  let posts = 0;
  globals(t, async (_url, options = {}) => {
    if (options.method === 'POST') posts++;
    return response({ ...state('2025-09-12'), dispatch: { readOnly: true, phase: 'published' } });
  });
  const errors = [];
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError: message => errors.push(message), login() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await client.send('complete_stop'), null);
  assert.equal(await client.send('calculate_dispatch', { vehicleIds: ['G1'] }), null);
  assert.equal(posts, 0);
  assert.match(errors[0], /과거 배차 기록/);
  client.close();
});
