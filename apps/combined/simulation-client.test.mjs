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
    constructor(url) { assert.equal(url, 'wss://demo.test/ws/simulation'); sockets.push(this); }
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
  socket.message({ type: 'state', boot: 'first', state: { phase: 'delivering' } });
  client.send('complete_stop', { stopId: 'S1' });
  assert.deepEqual(socket.sent, [{ type: 'complete_stop', stopId: 'S1' }]);
  socket.message({ type: 'error', error: 'INVALID_COMMAND' });
  assert.equal(errors.length, 1);
  socket.message({ type: 'state', boot: 'second', state: { phase: 'unordered' } });
  assert.equal(reloads, 1);
  assert.deepEqual(states, [{ phase: 'delivering' }]);
  socket.listeners.close({ code: 4401, reason: 'Session ended' });
  assert.equal(redirects[0], '/login?next=%2Fcombined%2F%3Fid%3DS5%23%2Fcontrol');
  socket.readyState = 3;
  client.send('advance');
  assert.equal(socket.sent.length, 1);
  assert.equal(errors.length, 2);
});
