const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation } = require('../workspaces/sanghyun-scenario/src/simulation');
const { applyRouteOrder, validRouteOrder } = require('../lib/route-order');

function setup() {
  const states = [];
  const sim = new Simulation(state => states.push(state));
  clearInterval(sim.timer);
  const request = () => ({ order: [...sim.order], expectedOrder: [...sim.order], expectedStatuses: sim.order.map(id => sim.stops[id].status), expectedPhase: sim.phase });
  return { sim, states, request };
}

test('route order save validates the full permutation and applies one state update', () => {
  const { sim, states, request } = setup();
  const msg = request();
  [msg.order[0], msg.order[4]] = [msg.order[4], msg.order[0]];
  assert.equal(validRouteOrder(msg), true);
  const before = states.length;
  assert.equal(applyRouteOrder(sim, msg), true);
  assert.deepEqual(sim.order, msg.order);
  assert.equal(states.length, before + 1);
  assert.match(sim.snapshot().events[0].message, /배송 순서/);
});

test('invalid, stale, and locked-stop route drafts leave state unchanged', () => {
  const { sim, request } = setup();
  const stale = request();
  sim.placeOrder();
  assert.equal(applyRouteOrder(sim, stale), false);
  for (let i = 0; i < 4; i++) sim.advance();
  const locked = request();
  [locked.order[0], locked.order[1]] = [locked.order[1], locked.order[0]];
  const before = sim.snapshot();
  assert.equal(applyRouteOrder(sim, locked), false);
  assert.deepEqual(sim.snapshot(), before);
  const duplicate = request();
  duplicate.order[1] = duplicate.order[0];
  assert.equal(validRouteOrder(duplicate), false);
  assert.equal(applyRouteOrder(sim, duplicate), false);
  const changed = request();
  sim.toggleSkip('S3');
  assert.equal(applyRouteOrder(sim, changed), false);
});

test('pending deliveries can move while current and completed deliveries stay fixed', () => {
  const { sim, request } = setup();
  sim.placeOrder();
  for (let i = 0; i < 4; i++) sim.advance();
  const msg = request();
  [msg.order[2], msg.order[5]] = [msg.order[5], msg.order[2]];
  const current = sim.truck.toId;
  assert.equal(applyRouteOrder(sim, msg), true);
  assert.equal(sim.truck.toId, current);
  assert.equal(sim.order[0], current);
});
