import test from 'node:test';
import assert from 'node:assert/strict';
import { connectSourceOperations, sourceDate } from './source-client.mjs';

const manifest = { schemaVersion: 1, defaultDate: '2025-09-12', dates: [{ date: '2025-09-12', weekday: '금요일' }, { date: '2025-09-13', weekday: '토요일' }] };
const response = (body, status = 200, etag = '"v1"') => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: name => name.toLowerCase() === 'etag' ? etag : null } });
const state = (date, revision = 1) => ({ boot: 'boot-1', revision, sourceData: { date, defaultVehicleId: 'G1' }, fleetDeliveries: [{ id: `O-${date}`, vehicleId: 'G1' }] });

function globals(t, fetchImpl, search = '?date=2025-09-12') {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, history: globalThis.history, sessionStorage: globalThis.sessionStorage, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const events = new Map(); const stored = new Map(); const timers = new Set(); const cleanups = []; const replaced = [];
  globalThis.fetch = fetchImpl; globalThis.location = { href: `https://demo.test/combined/${search}`, search };
  globalThis.history = { replaceState(_state, _title, url) { replaced.push(String(url)); } }; globalThis.sessionStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; };
  globalThis.clearTimeout = timer => timers.delete(timer);
  t.after(() => { cleanups.forEach(cleanup => cleanup()); Object.assign(globalThis, saved); });
  return { events, stored, timers, replaced, cleanup: callback => cleanups.push(callback) };
}

test('날짜 목록과 관계없이 서울의 실제 오늘을 쓰고 명시 날짜를 보존한다', () => {
  assert.equal(sourceDate(manifest, null, () => '2026-09-27'), '2026-09-27');
  assert.equal(sourceDate(manifest, '없는 날짜', () => '2026-09-27'), null);
  assert.equal(sourceDate(manifest, '2025-09-13'), '2025-09-13');
});

test('오늘 자료가 없어도 날짜 맥락을 제공하고 명령을 막으며 명시 날짜로 복구한다', async t => {
  const calls = [], contexts = [], states = [], statuses = [], errors = [];
  const { cleanup, replaced } = globals(t, async (url, options = {}) => {
    calls.push([url, options]);
    return response(state('2025-09-13'));
  }, '');
  const client = connectSourceOperations({ manifest, now: () => '2026-09-27', onDateContext: value => contexts.push(value),
    onState: value => states.push(value), onStatus: (...args) => statuses.push(args), onError: message => errors.push(message), login() {} });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contexts.at(-1).date, '2026-09-27');
  assert.deepEqual(states, []);
  assert.equal(calls.length, 0);
  assert.equal(await client.send('calculate_dispatch'), null);
  assert.equal(calls.length, 0);
  assert.match(statuses.at(-1)[1], /자료가 없습니다/);
  await client.selectDate('2025-09-13');
  assert.match(replaced.at(-1), /[?&]date=2025-09-13/);
  assert.equal(states.at(-1).sourceData.date, '2025-09-13');
  assert.equal(contexts.at(-1).date, '2025-09-13');
});

test('같은 날짜의 자료가 뒤에 사라지면 빈 날짜 맥락을 다시 통지하고 명령을 막는다', async t => {
  let reads = 0, posts = 0;
  const contexts = [];
  const { timers, cleanup } = globals(t, async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; return response({}); }
    return ++reads === 1 ? response(state('2025-09-12')) : response({ message: 'missing' }, 404);
  });
  const client = connectSourceOperations({ manifest, onDateContext: value => contexts.push(value), onState() {}, onStatus() {}, onError() {}, login() {} });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  await [...timers].find(timer => timer.delay === 2000).callback();
  assert.deepEqual(contexts.at(-1), { date: '2025-09-12', dates: manifest.dates, empty: true, invalid: false });
  assert.equal(await client.send('calculate_dispatch'), null);
  assert.equal(posts, 0);
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
  assert.equal(stored.get('meatbox.dispatch.date'), undefined);
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

test('연결 종료 뒤에는 남아 있는 상태로 명령을 보내지 않는다', async t => {
  let posts = 0;
  globals(t, async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; return response({ state: state('2025-09-12', 2) }); }
    return response(state('2025-09-12'));
  });
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError() {}, login() {} });
  await new Promise(resolve => setImmediate(resolve));
  client.close();
  assert.equal(await client.send('arrive_stop', { stopId: 'O-2025-09-12' }), null);
  assert.equal(posts, 0);
});

test('새 날짜를 조회하면 이전 날짜의 네트워크 요청을 취소한다', async t => {
  const oldDay = deferredResponse();
  let oldSignal;
  const { cleanup } = globals(t, async (url, options) => {
    if (url.endsWith('2025-09-12/state')) { oldSignal = options.signal; return oldDay.promise; }
    return response(state('2025-09-13'));
  });
  const states = [];
  const client = connectSourceOperations({ manifest, onState: value => states.push(value), onStatus() {}, onError() {}, login() {} });
  cleanup(() => client.close());
  await client.selectDate('2025-09-13');
  assert.equal(oldSignal?.aborted, true);
  oldDay.resolve(response(state('2025-09-12')));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states.map(value => value.sourceData.date), ['2025-09-13']);
});

test('이전 날짜 명령의 늦은 인증 오류는 새 날짜 연결을 종료하지 않는다', async t => {
  const oldCommand = deferredResponse();
  let logins = 0;
  const { cleanup } = globals(t, async (url, options = {}) => options.method === 'POST' ? oldCommand.promise
    : response(state(url.includes('2025-09-13') ? '2025-09-13' : '2025-09-12')));
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError() {}, login: () => logins++ });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  const sending = client.send('arrive_stop');
  await client.selectDate('2025-09-13');
  oldCommand.resolve(response(null, 401));
  await sending;
  assert.equal(logins, 0);
});

test('화면이 거절한 상태는 다음 명령의 revision 기준으로 사용하지 않는다', async t => {
  const calls = []; let rejectState = true;
  const { timers, cleanup } = globals(t, async (_url, options = {}) => {
    calls.push(options);
    return response(state('2025-09-12', 7));
  });
  const client = connectSourceOperations({ manifest, onState() { if (rejectState) throw new Error('render failed'); }, onStatus() {}, onError() {}, login() {} });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  await client.send('arrive_stop');
  assert.equal(calls.some(options => options.method === 'POST'), false);
  rejectState = false;
  await [...timers].find(timer => timer.delay === 2000).callback();
  assert.equal(calls.at(-1).headers['If-None-Match'], undefined);
});

test('응답이 멈춘 상태 조회는 시간 제한 후 다음 조회로 복구한다', async t => {
  const statuses = []; let signal;
  const { timers, cleanup } = globals(t, (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const client = connectSourceOperations({ manifest, onState() {}, onStatus: (...args) => statuses.push(args), onError() {}, login() {} });
  cleanup(() => client.close());
  const deadline = [...timers].find(timer => timer.delay === 10000);
  assert.ok(deadline, 'state requests need a bounded deadline');
  deadline.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(statuses.at(-1)[0], false);
  assert.ok([...timers].some(timer => timer.delay === 2000));
});

test('명령 인증 만료 시 폴링과 후속 명령을 중단한다', async t => {
  let posts = 0, logins = 0;
  const { timers, cleanup } = globals(t, async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; return response(null, 401); }
    return response(state('2025-09-12'));
  });
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError() {}, login: () => logins++ });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  await client.send('arrive_stop');
  await client.send('arrive_stop');
  assert.equal(logins, 1);
  assert.equal(posts, 1);
  assert.equal(timers.size, 0);
});

test('명령 응답이 멈추면 재전송하지 않고 최신 상태로 처리 여부를 확인한다', async t => {
  const posts = [], errors = [];
  const { timers, cleanup } = globals(t, async (_url, options = {}) => {
    if (options.method !== 'POST') return response(state('2025-09-12', posts.length ? 2 : 1));
    posts.push(JSON.parse(options.body));
    if (posts.length === 1) return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return response({ state: state('2025-09-12', 3), result: { accepted: true } });
  });
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError: message => errors.push(message), login() {} });
  cleanup(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  const sending = client.send('arrive_stop');
  [...timers].find(timer => timer.delay === 10000).callback();
  assert.equal(await sending, null);
  assert.equal(posts.length, 1);
  assert.match(errors[0], /처리 여부/);
  assert.deepEqual(await client.send('complete_stop'), { accepted: true });
  assert.equal(posts[1].expectedRevision, 2);
});

test('경로를 바꾼 명령의 응답에 있던 기사 알림 정보를 결과와 함께 돌려주고 없으면 결과를 그대로 둔다', async t => {
  const notice = { vehicles: 1, push: 'unconfigured', changes: [{ vehicleId: 'G1', text: '배차가 변경되었습니다. 순서 변경' }] };
  let withNotice = true;
  globals(t, async url => (url.endsWith('/state') ? response(state('2025-09-12')) : response({ state: state('2025-09-12', 2), result: { changedCount: 1 }, ...(withNotice ? { driverNotice: notice } : {}) }, 200, '"v2"')));
  const client = connectSourceOperations({ manifest, onState() {}, onStatus() {}, onError() {}, login() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await client.send('reassign', { orderIds: ['O-2025-09-12'], targetVehicleId: 'G2' }), { changedCount: 1, driverNotice: notice });
  withNotice = false;
  assert.deepEqual(await client.send('reassign', { orderIds: ['O-2025-09-12'], targetVehicleId: 'G2' }), { changedCount: 1 });
  client.close();
});
