import test from 'node:test';
import assert from 'node:assert/strict';
import simulation from '../../workspaces/sanghyun-scenario/src/simulation.js';
import controls from '../../lib/scenario-controls.js';
import { adaptSimulation } from './simulation-adapter.mjs';
import { deliveryLinks, deliveryContext, deliveryChanges } from './delivery-review.mjs';

function fixture() {
  const sim = new simulation.Simulation(() => {});
  clearInterval(sim.timer);
  return { sim, snapshot: () => adaptSimulation(sim.snapshot()) };
}

test('고객 링크는 같은 배송을 유지하며 잘못된 배송 ID를 URL에 전달하지 않는다', () => {
  const links = deliveryLinks('S1');
  assert.equal(links.mobile, '/combined/mobile-customer.html?id=S1');
  assert.equal(links.customer, links.mobile);
  assert.equal(links.driver, '/combined/driver.html?id=S1');
  assert.equal(links.operator, '/combined/?id=S1#/control');
  assert.equal(deliveryLinks('V130-S3').customer, '/combined/mobile-customer.html?id=V130-S3');
  for (const id of [null, 'S9', 'V131-S1', 'V2-S4', 'S1&next=https://example.invalid', '../']) {
    assert.equal(deliveryLinks(id).operator, '/combined/#/control');
    assert.equal(deliveryLinks(id).driver, '/combined/driver.html');
  }
});

test('시연 고객 S5와 첫 목적지 S1을 구분하고 실제 배송 순서 변경을 따른다', () => {
  const { sim, snapshot } = fixture();
  let state = snapshot();
  const before = structuredClone(state);
  assert.match(deliveryContext(state, state.deliveries[4]).note, /5번 호수정육식당.*1번 문정갈비/);
  assert.deepEqual(state, before);
  sim.placeOrder();
  for (let i = 0; i < 4; i++) sim.advance();
  state = snapshot();
  assert.match(deliveryContext(state, state.deliveries[4]).note, /앞선 배송 4곳/);
  sim.reorder('S5', 'up');
  state = snapshot();
  const customer = state.deliveries.find(stop => stop.id === 'S5');
  assert.match(deliveryContext(state, customer).customer, /^4번 호수정육식당/);
  assert.match(deliveryContext(state, customer).note, /앞선 배송 3곳/);
});

test('주문 전 ETA를 노출하지 않고 상태와 고객 안내의 전후 값을 구분한다', () => {
  const { sim, snapshot } = fixture();
  const unordered = snapshot();
  assert.equal(deliveryChanges(null, unordered), null);
  sim.placeOrder();
  const ordered = snapshot();
  const change = deliveryChanges(unordered, ordered);
  assert.equal(change.time, '05:45');
  assert.deepEqual(change.deliveries.S5.rows.find(row => row.label === '고객 공식 ETA'), { label: '고객 공식 ETA', before: '미확인', after: '07:10' });
  const ticking = structuredClone(ordered);
  ticking.simClock = '05:46';
  ticking.deliveries[4].calculatedEta = '07:09';
  assert.equal(deliveryChanges(ordered, ticking), null);
  sim.reset();
  assert.equal(deliveryChanges(ordered, snapshot()), null);
});

test('첫 배송의 도착과 완료를 구분하고 S5를 완료 처리한 것처럼 표시하지 않는다', () => {
  const { sim, snapshot } = fixture();
  sim.placeOrder();
  for (let i = 0; i < 4; i++) sim.advance();
  const moving = snapshot();
  controls.arriveStop(sim, 'S1');
  const arrived = snapshot();
  assert.ok(deliveryChanges(moving, arrived).deliveries.S1.rows.some(row => row.label === '도착 시각'));
  assert.equal(deliveryChanges(moving, arrived).deliveries.S1.rows.some(row => row.label === '완료 시각'), false);
  controls.completeStop(sim, 'S1');
  const done = snapshot();
  const change = deliveryChanges(arrived, done);
  assert.ok(change.global.some(row => row.label === '완료 배송' && row.before === '0곳' && row.after === '1곳'));
  assert.ok(change.deliveries.S1.rows.some(row => row.label === '완료 시각'));
  assert.equal(change.deliveries.S5?.rows.some(row => row.label === '완료 시각') || false, false);
  assert.match(deliveryContext(done, done.deliveries[4]).note, /앞선 배송 3곳/);
});
