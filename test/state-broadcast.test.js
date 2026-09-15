const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStateSender } = require('../lib/state-broadcast');

const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  readyState = 1;
  protocol = 'meatbox-state-v2';
  sent = [];
  callbacks = [];
  send(message, callback) { this.sent.push(message); this.callbacks.push(callback); }
  finish() { this.callbacks.shift()(); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006); }
}
const frame = revision => ({ revision, baseRevision: revision - 1, full: `full-${revision}`, patch: `patch-${revision}` });

test('최초 연결은 전체 상태, 다음 갱신은 변경분, 누락 뒤에는 최신 전체 상태를 보낸다', async () => {
  let latest = frame(1);
  const send = createStateSender({ latest: () => latest, session: async () => ({}) });
  const ws = new Socket();
  send(ws); await tick();
  assert.deepEqual(ws.sent, ['full-1']);
  latest = frame(2); send(ws);
  latest = frame(3); send(ws);
  assert.equal(ws.sent.length, 1, '느린 연결에 프레임을 추가 적재하지 않는다');
  ws.finish(); await tick();
  assert.deepEqual(ws.sent, ['full-1', 'full-3']);
  ws.finish();
  latest = frame(4); send(ws); await tick();
  assert.equal(ws.sent.at(-1), 'patch-4');
  ws.finish();
  send(ws); await tick();
  assert.equal(ws.sent.length, 3, '전송한 리비전을 반복하지 않는다');
});

test('구형 뷰어는 전체 상태를 받고 인증 중 갱신도 최신 상태로 합쳐진다', async () => {
  let latest = frame(1), authenticate;
  const send = createStateSender({ latest: () => latest, session: () => new Promise(resolve => { authenticate = resolve; }) });
  const ws = new Socket(); ws.protocol = '';
  send(ws); latest = frame(2); send(ws);
  authenticate({}); await tick();
  assert.deepEqual(ws.sent, ['full-2']);
  ws.finish();
});

test('만료 인증과 전송 실패는 상태 전송을 중단한다', async () => {
  const revoked = new Socket();
  createStateSender({ latest: () => frame(1), session: async () => null })(revoked);
  await tick(); assert.equal(revoked.code, 4401); assert.equal(revoked.sent.length, 0);
  const failed = new Socket();
  createStateSender({ latest: () => frame(1), session: async () => ({}) })(failed);
  await tick(); failed.callbacks.shift()(new Error('write failed'));
  assert.equal(failed.readyState, 3);
});

test('느린 소켓은 제한 시간 뒤 종료하고 다시 연결하면 최신 전체 상태를 받는다', async () => {
  let latest = frame(1);
  const send = createStateSender({ latest: () => latest, session: async () => ({}), timeoutMs: 25 });
  const slow = new Socket(); send(slow); await tick();
  latest = frame(9); send(slow);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(slow.readyState, 3);
  const recovered = new Socket(); send(recovered); await tick();
  assert.deepEqual(recovered.sent, ['full-9']); recovered.finish();
});
