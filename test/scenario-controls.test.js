'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { arriveStop, completeStop, MAX_ARRIVAL_TICKS } = require('../lib/scenario-controls');
const { validCommand } = require('../server');
const { Simulation } = require('../workspaces/sanghyun-scenario/src/simulation');
const { OperatingSimulation } = require('../lib/operating-simulation');

function simulation() {
  const states = [];
  const sim = new Simulation(state => states.push(state));
  clearInterval(sim.timer);
  return { sim, states };
}

function depart(sim) {
  sim.placeOrder();
  for (let step = 0; step < 4; step++) sim.advance();
  assert.equal(sim.snapshot().truck.toId, 'S1');
}

test('원본 시뮬레이션 단계로 주문부터 첫 배송 완료와 둘째 배송지 이동까지 진행한다', () => {
  const { sim } = simulation();
  depart(sim);
  const speed = sim.snapshot().speed;

  assert.equal(completeStop(sim, 'S1'), false, '도착 전 완료는 거절');
  assert.equal(arriveStop(sim, 'S2'), false, '현재 목적지가 아닌 도착 명령은 무시');
  assert.equal(arriveStop(sim, 'S1'), true);
  let state = sim.snapshot();
  assert.equal(state.speed, speed);
  assert.equal(state.truck.fromId, 'S1');
  assert.equal(state.truck.toId, null);
  assert.equal(state.truck.progress, 0);
  assert.equal(state.truck.dwelling, true);
  assert.equal(state.order[0].status, 'current');
  assert.ok(state.order[0].arrivedTime);
  assert.equal(state.order[0].deliveredTime, null);

  assert.equal(arriveStop(sim, 'S1'), false, '중복 도착은 무시');
  assert.equal(completeStop(sim, 'S2'), false, '다른 배송지 완료는 무시');
  assert.equal(completeStop(sim, 'S1'), true);
  state = sim.snapshot();
  assert.equal(state.order[0].status, 'done');
  assert.ok(state.order[0].deliveredTime);
  assert.equal(state.truck.toId, 'S2');
  assert.equal(state.truck.dwelling, false);
  assert.equal(completeStop(sim, 'S1'), false, '완료 버튼 재입력은 무시');
});

test('stopId 없는 기존 기사 완료 요청은 계속 원본 completeCurrentStop을 호출한다', () => {
  const { sim } = simulation();
  depart(sim);
  assert.equal(arriveStop(sim, 'S1'), true);
  let calls = 0;
  const original = sim.completeCurrentStop.bind(sim);
  sim.completeCurrentStop = () => { calls++; original(); };

  assert.equal(completeStop(sim), true);
  assert.equal(calls, 1);
  assert.equal(sim.snapshot().order[0].status, 'done');
});

test('도착 명령은 원본 tick을 반복하며 원본 교통 지연과 현재 배속을 보존한다', () => {
  function elapsed(traffic) {
    const { sim } = simulation();
    depart(sim);
    sim.setSpeed(20);
    if (traffic) sim.injectTraffic();
    const startedAt = sim.snapshot().simTime;
    let ticks = 0;
    const original = sim.tick.bind(sim);
    sim.tick = manual => { ticks++; original(manual); };

    assert.equal(arriveStop(sim, 'S1'), true);
    const state = sim.snapshot();
    assert.equal(state.speed, 20);
    assert.ok(ticks > 0);
    return state.simTime - startedAt;
  }

  assert.ok(elapsed(true) > elapsed(false));
});

test('게이트웨이는 arrive_stop과 선택적 stopId 완료 명령을 배송지 범위로 제한한다', () => {
  assert.equal(validCommand({ type: 'arrive_stop', stopId: 'S1' }), true);
  assert.equal(validCommand({ type: 'arrive_stop' }), false);
  assert.equal(validCommand({ type: 'arrive_stop', stopId: 'S9' }), false);
  assert.equal(validCommand({ type: 'complete_stop' }), true);
  assert.equal(validCommand({ type: 'complete_stop', stopId: 'S8' }), true);
  assert.equal(validCommand({ type: 'complete_stop', stopId: 'S9' }), false);
});

test('비정상적으로 끝나지 않는 이동은 상한에서 중단하고 상태를 전송하지 않는다', () => {
  let ticks = 0;
  let emits = 0;
  const sim = {
    snapshot: () => ({ phase: 'delivering', truck: { toId: 'S1', dwelling: false } }),
    tick: manual => { assert.equal(manual, true); ticks++; },
    emit: () => { emits++; },
  };

  assert.equal(arriveStop(sim, 'S1'), false);
  assert.equal(ticks, MAX_ARRIVAL_TICKS);
  assert.equal(emits, 0);
});

test('운영 수동 도착은 원본 tick 반복 없이 한 번에 고정 상태로 전환한다', () => {
  let latest;
  const sim = new OperatingSimulation(state => { latest = state; });
  assert.equal(sim.setScenario('shipping', 'S5'), true);
  sim.tick = () => { throw new Error('운영 도착에서 tick을 호출하면 안 됩니다.'); };
  assert.equal(arriveStop(sim, 'S5'), true);
  assert.equal(latest.scenarioPreset, 'arrived');
  assert.equal(latest.scenarioStopId, 'S5');
  assert.equal(latest.truck.fromId, 'S5');
  assert.equal(latest.truck.dwelling, true);
});

test('운영 상태 변경은 주문과 배송 사건으로 한 번만 기록한다', () => {
  const sim = new OperatingSimulation(() => {});
  assert.equal(sim.events.at(-1).message, '주문 접수 완료');
  assert.equal(sim.events.at(-1).type, 'stage');
  for (const [scenario, event] of [
    ['picking', '피킹 시작'], ['ready', '출고 준비 완료'], ['shipping', '배송 출발'],
    ['arrived', '도착'], ['completed', '배송 완료'], ['received', '주문 접수 완료'],
  ]) {
    const before = sim.events.length;
    assert.equal(sim.setScenario(scenario, 'S1'), true);
    assert.equal(sim.events.length, before + 1);
    assert.equal(sim.events.at(-1).message, `문정갈비 ${event}`);
    assert.equal(sim.events.at(-1).type, 'stage');
    assert.equal(sim.setScenario(scenario, 'S1'), false);
    assert.equal(sim.events.length, before + 1);
  }
});
