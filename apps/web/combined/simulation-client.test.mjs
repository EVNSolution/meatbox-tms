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
  globalThis.location = { protocol: 'https:', host: 'demo.test', href: 'https://demo.test/combined/?id=O1&date=2026-09-16', pathname: '/combined/', search: '?id=O1&date=2026-09-16', hash: '', replace() {}, reload() {} };
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

for (const [label, status, reader] of [
  ['원본 입력 누락', 404, null], ['Kotlin 입력 누락', 404, 'kotlin'],
  ['Kotlin 조회 실패', 503, 'kotlin'], ['미확정 조회자 입력 누락', 404, 'future-reader'],
]) {
  test(`${label}은 가상 상태로 바뀌지 않고 재조회한다`, async t => {
    const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location,
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const requests = [], retries = [], statuses = [], errors = [];
    globalThis.location = { pathname: '/combined/', search: '', hash: '', replace() { assert.fail('입력 오류는 로그인 오류가 아니다'); } };
    globalThis.WebSocket = class { constructor() { assert.fail('폐기한 시뮬레이션에 연결하지 않는다'); } };
    globalThis.fetch = async url => {
      requests.push(url);
      return url === '/api/session' ? Response.json({ user: { username: 'reviewer' } })
        : Response.json({ error: 'DISPATCH_DATA_UNAVAILABLE' }, { status, headers: reader ? { 'x-meatbox-source-reader': reader } : {} });
    };
    globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; retries.push(timer); return timer; };
    globalThis.clearTimeout = timer => { if (timer) timer.cancelled = true; };
    const client = connectSimulation({ onState() { assert.fail('누락된 입력으로 업무 상태를 만들지 않는다'); },
      onStatus(connected, message) { statuses.push({ connected, message }); }, onError: message => errors.push(message) });
    t.after(() => { client.close(); Object.assign(globalThis, saved); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, ['/api/session', '/api/dispatch-data/manifest']);
    assert.match(statuses.at(-1).message, /원본 주문 자료를 불러올 수 없습니다/);
    assert.equal(statuses.at(-1).connected, false);
    assert.ok(retries[0].delay >= 1500 && retries[0].delay < 2500);
    client.send('calculate_dispatch');
    assert.equal(errors.length, 1);
    retries[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 4);
    assert.ok(retries[1].delay >= 3000 && retries[1].delay < 4000);
    client.close();
    assert.equal(retries[1].cancelled, true);
  });
}
