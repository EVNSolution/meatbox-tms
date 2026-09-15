import test from 'node:test';
import assert from 'node:assert/strict';
import { connectSimulation } from './simulation-client.mjs';

test('뷰어 연결은 상태와 명령을 전달하고 세션 종료와 서버 재시작을 구분한다', async t => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location };
  const sockets = [], states = [], errors = [], redirects = [];
  let reloads = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
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
  globalThis.fetch = async () => ({ ok: true, status: 200 });
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
