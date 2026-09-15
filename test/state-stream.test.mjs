import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createDemo } from '../server.js';
import { createStateReceiver } from '../apps/combined/state-frames.mjs';
import { capacityFixture } from '../scripts/capacity-fixture.cjs';

function next(ws) { return once(ws, 'message').then(([raw]) => JSON.parse(raw)); }

test('4550건을 실제 WS로 전송하고 변경분, 구형 뷰어, 재연결과 세션 취소를 검증한다', { timeout: 10_000 }, async t => {
  let authorized = true;
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ origin, access: { session: async token => authorized && token === 'capacity-test-token' ? { username: 'capacity-test' } : null } });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(() => demo.close());
  const state = capacityFixture();
  demo.sim.broadcast(state);
  const url = `ws://127.0.0.1:${demo.server.address().port}/ws/simulation`;
  const options = { headers: { origin, cookie: 'meatbox_session=capacity-test-token' } };
  const modern = new WebSocket(url, 'meatbox-state-v2', options);
  const legacy = new WebSocket(url, options);
  const receiver = createStateReceiver();
  const [initial, oldInitial] = await Promise.all([next(modern), next(legacy)]);
  assert.equal(initial.type, 'state');
  assert.deepEqual(receiver.receive(initial), state);
  assert.deepEqual(oldInitial.state, state);

  const delivered = next(modern), oldDelivered = next(legacy);
  state.fleet.deliveries[3_001].tip = { body: '후문 인계', author: '검증 배송원', updatedAt: 60_000 };
  demo.sim.broadcast(state);
  const [changed, oldChanged] = await Promise.all([delivered, oldDelivered]);
  assert.equal(changed.type, 'state_patch');
  assert.ok(Buffer.byteLength(JSON.stringify(changed)) < 1_024);
  assert.deepEqual(receiver.receive(changed), state);
  assert.equal(oldChanged.type, 'state');
  assert.deepEqual(oldChanged.state, state);

  modern.terminate();
  const reconnected = new WebSocket(url, 'meatbox-state-v2', options);
  const restored = await next(reconnected);
  assert.equal(restored.type, 'state');
  assert.deepEqual(createStateReceiver().receive(restored), state);
  authorized = false;
  const closed = once(reconnected, 'close');
  demo.sim.broadcast(state);
  assert.equal((await closed)[0], 4401);
});
