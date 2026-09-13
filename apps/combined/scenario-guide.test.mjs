import test from 'node:test';
import assert from 'node:assert/strict';
import simulation from '../../workspaces/sanghyun-scenario/src/simulation.js';
import controls from '../../lib/scenario-controls.js';
import { adaptSimulation } from './simulation-adapter.mjs';
import { scenarioGuide } from './scenario-guide.mjs';

function fixture() {
  const sim = new simulation.Simulation(() => {});
  clearInterval(sim.timer);
  return { sim, guide: () => scenarioGuide(adaptSimulation(sim.snapshot())) };
}

test('가이드는 원본의 단계별 시각과 다음 행동, 변경 설명을 안내한다', () => {
  const { sim, guide } = fixture();
  assert.equal(guide().action, 'place_order');
  assert.equal(guide().nextTime, '05:45');
  sim.placeOrder();
  for (const [title, nextTime, elapsed] of [
    ['주문 접수', '05:50', 5],
    ['피킹 중', '06:05', 15],
    ['라벨 부착', '06:20', 15],
    ['상차 대기', '06:30', 10],
  ]) {
    const current = guide();
    assert.equal(current.title, title);
    assert.equal(current.nextTime, nextTime);
    assert.equal(current.elapsed, `시연 시간 +${elapsed}분`);
    assert.equal(current.action, 'advance');
    assert.ok(current.effect.length > 10);
    sim.advance();
  }
  assert.equal(guide().action, 'arrive_stop');
  assert.equal(guide().stopId, 'S1');
  assert.equal(guide().estimated, true);
  assert.ok(guide().steps.every(step => step.state === 'done' && step.actualTime));
});

test('가이드에서 도착과 완료를 분리하고 8개 배송지를 끝까지 안내한다', () => {
  const { sim, guide } = fixture();
  sim.placeOrder();
  for (let i = 0; i < 4; i++) sim.advance();
  for (let i = 1; i <= 8; i++) {
    const stopId = `S${i}`;
    assert.equal(guide().action, 'arrive_stop');
    assert.equal(guide().stopId, stopId);
    assert.equal(controls.arriveStop(sim, stopId), true);
    assert.equal(guide().action, 'complete_stop');
    assert.equal(guide().stopId, stopId);
    assert.ok(guide().current.arrivedAt);
    assert.equal(guide().current.completedAt, null);
    assert.equal(guide().elapsed, '현재 시각에 완료 스캔');
    assert.equal(controls.completeStop(sim, stopId), true);
    assert.equal(guide().doneCount, i);
    assert.equal(guide().latestCompleted.id, stopId);
    assert.ok(guide().latestCompleted.completedAt);
  }
  assert.equal(guide().title, '배송 시연 완료');
  assert.equal(guide().action, undefined);
  sim.reset();
  assert.equal(guide().action, 'place_order');
  assert.equal(guide().doneCount, 0);
  assert.equal(guide().latestCompleted, null);
});

test('정차 지연과 건너뜀을 안내에 반영하면서 시뮬레이션 결과를 바꾸지 않는다', () => {
  const { sim, guide } = fixture();
  sim.placeOrder();
  sim.toggleSkip('S2');
  for (let i = 0; i < 4; i++) sim.advance();
  controls.arriveStop(sim, 'S1');
  sim.injectDwell();
  const before = sim.snapshot();
  assert.match(guide().description, /약 10분/);
  assert.match(guide().effect, /3번/);
  assert.equal(guide().totalCount, 7);
  assert.deepEqual(sim.snapshot(), before);
  assert.equal(scenarioGuide(null), null);
});
