import test from 'node:test';
import assert from 'node:assert/strict';
import { connectSimulation, expandSourceCommand } from './simulation-client.mjs';

test('종료한 연결은 늦게 읽힌 날짜 목록으로 상태 조회를 다시 시작하지 않는다', async t => {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, window: globalThis.window,
    sessionStorage: globalThis.sessionStorage, history: globalThis.history };
  let finishManifest; const calls = [], listeners = [];
  const manifest = new Promise(resolve => { finishManifest = resolve; });
  globalThis.fetch = async url => {
    calls.push(url);
    if (url === '/api/dispatch-data/manifest') return { status: 200, ok: true, json: () => manifest };
    return { status: 200, ok: true };
  };
  globalThis.location = { href: 'https://demo.test/combined/', search: '' };
  globalThis.window = { addEventListener: name => listeners.push(name), removeEventListener() {} };
  globalThis.sessionStorage = { getItem() { return null; } };
  const client = connectSimulation({ onState() {}, onStatus() {}, onError() {} });
  t.after(() => { client.close(); Object.assign(globalThis, saved); });
  await new Promise(resolve => setImmediate(resolve));
  client.close();
  finishManifest({ schemaVersion: 1, defaultDate: '2026-09-16', dates: [{ date: '2026-09-16' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['/api/session', '/api/dispatch-data/manifest']);
  assert.deepEqual(listeners, []);
});

test('묶음 순서 명령은 원본 주문 순서와 개별 상태 CAS로 확장된다', () => {
  const state = { sourceData: { date: '2026-09-16' }, fleetDeliveries: [
    { id: 'O1', vehicleId: 'V1', name: 'A', address: '서울', status: 'current' },
    { id: 'O2', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
    { id: 'O3', vehicleId: 'V1', name: 'B', address: '부산', status: 'pending' },
  ] };
  const expanded = expandSourceCommand('set_route_order', {
    vehicleId: 'V1', order: ['O3', 'O1'], expectedOrder: ['O1', 'O3'], expectedStatuses: ['current', 'pending'], expectedPhase: 'delivering',
  }, state);
  assert.deepEqual(expanded, {
    vehicleId: 'V1', order: ['O3', 'O1', 'O2'], expectedOrder: ['O1', 'O2', 'O3'], expectedStatuses: ['current', 'pending', 'pending'], expectedPhase: 'delivering',
  });
  const raw = { vehicleId: 'V1', order: ['O1', 'O2', 'O3'], expectedOrder: ['O1', 'O2', 'O3'], expectedStatuses: ['current', 'pending', 'pending'] };
  assert.deepEqual(expandSourceCommand('set_route_order', raw, state), raw);
  assert.deepEqual(expandSourceCommand('complete_stop', { stopId: 'O1' }, state), { stopId: 'O1' });
});

test('오래된 compact 상태 기준은 최신 원본 상태로 덮어쓰지 않는다', () => {
  const state = { sourceData: { date: '2026-09-16' }, fleetDeliveries: [
    { id: 'O1', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
    { id: 'O3', vehicleId: 'V1', name: 'B', address: '부산', status: 'pending' },
    { id: 'O2', vehicleId: 'V1', name: 'A', address: '서울', status: 'skipped' },
  ] };
  const expanded = expandSourceCommand('set_route_order', {
    vehicleId: 'V1', order: ['O3', 'O1'], expectedOrder: ['O1', 'O3'], expectedStatuses: ['skipped', 'pending'], expectedPhase: 'delivering',
  }, state);
  assert.deepEqual(expanded.order, ['O3', 'O1', 'O2']);
  assert.deepEqual(expanded.expectedOrder, ['O1', 'O3']);
  assert.deepEqual(expanded.expectedStatuses, ['skipped', 'pending']);
});

test('오래된 compact 순서와 멤버십 변경 전 raw 기준은 서버 거부용 원본을 유지한다', () => {
  const state = { sourceData: { date: '2026-09-16' }, fleetDeliveries: [
    { id: 'O1', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
    { id: 'O2', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
    { id: 'O2B', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
    { id: 'O3', vehicleId: 'V1', name: 'B', address: '부산', status: 'pending' },
  ] };
  const staleCompact = expandSourceCommand('set_route_order', {
    vehicleId: 'V1', order: ['O3', 'O1'], expectedOrder: ['O3', 'O1'], expectedStatuses: ['pending', 'pending'],
  }, state);
  assert.deepEqual(staleCompact.expectedOrder, ['O3', 'O1']);
  assert.deepEqual(staleCompact.expectedStatuses, ['pending', 'pending']);
  const staleRaw = expandSourceCommand('set_route_order', {
    vehicleId: 'V1', order: ['O3', 'O1'], expectedOrder: ['O1', 'O2', 'O3'], expectedStatuses: ['pending', 'pending', 'pending'],
  }, state);
  assert.deepEqual(staleRaw.expectedOrder, ['O1', 'O2', 'O3']);
  assert.deepEqual(staleRaw.expectedStatuses, ['pending', 'pending', 'pending']);
});

test('source 연결은 묶음 UI 순서를 원본 주문 명령으로 확장한 뒤 게시한다', async t => {
  const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location,
    history: globalThis.history, sessionStorage: globalThis.sessionStorage, window: globalThis.window,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const posts = [];
  const sourceState = { boot: 'boot-1', revision: 1, sourceData: { date: '2026-09-16', defaultVehicleId: 'V1' },
    fleetDeliveries: [
      { id: 'O1', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
      { id: 'O2', vehicleId: 'V1', name: 'A', address: '서울', status: 'pending' },
      { id: 'O3', vehicleId: 'V1', name: 'B', address: '부산', status: 'pending' },
    ] };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/session') return response({});
    if (url === '/api/dispatch-data/manifest') return response({ schemaVersion: 1, defaultDate: '2026-09-16', dates: [{ date: '2026-09-16', weekday: '수요일' }] });
    if (url.endsWith('/state')) return response(sourceState);
    if (url.endsWith('/commands')) { posts.push(JSON.parse(options.body)); return response({ state: { ...sourceState, revision: 2 }, result: {} }); }
    return response({}, 404);
  };
  globalThis.location = { protocol: 'https:', host: 'demo.test', href: 'https://demo.test/combined/?id=O1', pathname: '/combined/', search: '?id=O1', hash: '', replace() {}, reload() {} };
  globalThis.history = { replaceState() {} };
  globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.setTimeout = () => 1; globalThis.clearTimeout = () => {};
  const client = connectSimulation({ onState() {}, onStatus() {}, onError() {} });
  t.after(() => { client.close(); Object.assign(globalThis, saved); });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await client.send('set_route_order', { vehicleId: 'V1', order: ['O3', 'O1'], expectedOrder: ['O1', 'O3'], expectedStatuses: ['pending', 'pending'], expectedPhase: 'idle' });
  assert.deepEqual(posts[0].order, ['O3', 'O1', 'O2']);
  assert.deepEqual(posts[0].expectedOrder, ['O1', 'O2', 'O3']);
  assert.deepEqual(posts[0].expectedStatuses, ['pending', 'pending', 'pending']);
});

test('뷰어 연결은 상태와 명령을 전달하고 세션 종료와 서버 재시작을 구분한다', async t => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location };
  const sockets = [], states = [], errors = [], redirects = [];
  let reloads = 0;
  globalThis.fetch = async url => url.endsWith('/manifest') ? ({ ok: false, status: 404 }) : ({ ok: true, status: 200 });
  globalThis.location = { protocol: 'https:', host: 'demo.test', pathname: '/combined/', search: '?id=S5', hash: '#/control', replace: url => redirects.push(url), reload: () => reloads++ };
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    sent = [];
    constructor(url, protocol) { assert.equal(protocol, 'meatbox-state-v2'); assert.equal(url, 'wss://demo.test/ws/simulation'); sockets.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.listeners.close?.({ code: 1000, reason: '' }); }
    message(data) { this.listeners.message({ data: JSON.stringify(data) }); }
  };
  const client = connectSimulation({ onState: state => states.push(state), onStatus() {}, onError: message => errors.push(message) });
  t.after(() => { client.close(); Object.assign(globalThis, original); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.message({ type: 'state', boot: 'first', revision: 1, state: { phase: 'delivering' } });
  client.send('complete_stop', { stopId: 'S1' });
  assert.deepEqual(socket.sent, [{ type: 'complete_stop', stopId: 'S1' }]);
  socket.message({ type: 'state_patch', boot: 'first', baseRevision: 1, revision: 2, changes: { phase: 'done' }, removed: [] });
  socket.message({ type: 'error', error: 'INVALID_COMMAND' });
  assert.equal(errors.length, 1);
  socket.message({ type: 'state', boot: 'second', state: { phase: 'unordered' } });
  assert.equal(reloads, 1);
  assert.deepEqual(states, [{ phase: 'delivering' }, { phase: 'done' }]);
  socket.listeners.close({ code: 4401, reason: 'Session ended' });
  assert.equal(redirects[0], '/login?next=%2Fcombined%2F%3Fid%3DS5%23%2Fcontrol');
  socket.readyState = 3;
  client.send('advance');
  assert.equal(socket.sent.length, 1);
  assert.equal(errors.length, 2);
});

test('화면이 변경분을 거절하면 재연결하여 최신 전체 상태로 복구하고 재시도를 분산한다', async t => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const sockets = [], states = [], retries = [];
  globalThis.fetch = async url => url.endsWith('/manifest') ? ({ ok: false, status: 404 }) : ({ ok: true, status: 200 });
  globalThis.location = { protocol: 'http:', host: 'local.test', pathname: '/', search: '', hash: '', replace() {}, reload() {} };
  globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; retries.push(timer); return timer; };
  globalThis.clearTimeout = timer => { if (timer) timer.cancelled = true; };
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() { sockets.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.listeners.close?.({ code: 1000, reason: '' }); }
    message(data) { this.listeners.message({ data: JSON.stringify(data) }); }
  };
  const client = connectSimulation({ onState(state) { if (!Array.isArray(state.order)) throw new Error('Invalid order'); states.push(state); }, onStatus() {}, onError() {} });
  t.after(() => { client.close(); Object.assign(globalThis, original); });
  await new Promise(resolve => setImmediate(resolve));
  sockets[0].message({ type: 'state', boot: 'first', revision: 1, state: { order: [] } });
  sockets[0].message({ type: 'state_patch', boot: 'first', baseRevision: 1, revision: 2, changes: {}, removed: ['order'] });
  assert.equal(sockets[0].readyState, 3);
  assert.equal(states.length, 1);
  assert.ok(retries[0].delay >= 1500 && retries[0].delay < 2500);
  retries[0].callback(); await new Promise(resolve => setImmediate(resolve));
  sockets[1].message({ type: 'state', boot: 'first', revision: 3, state: {} });
  assert.equal(sockets[1].readyState, 3);
  assert.ok(retries[1].delay >= 3000 && retries[1].delay < 4000);
  retries[1].callback(); await new Promise(resolve => setImmediate(resolve));
  sockets[2].message({ type: 'state', boot: 'first', revision: 9, state: { order: ['S1'] } });
  assert.deepEqual(states, [{ order: [] }, { order: ['S1'] }]);
  sockets[2].close();
  assert.ok(retries[2].delay >= 1500 && retries[2].delay < 2500, '정상 상태를 받으면 대기 시간을 초기화한다');
});
