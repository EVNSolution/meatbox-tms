'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { exampleRequestsFor } = require('../lib/customer-requests');
const { OperatingSimulation } = require('../lib/operating-simulation');

const arrive = (sim, stopId) => {
  assert.equal(sim.setScenario('arrived', stopId), true);
  assert.equal(sim.truck.atStopId, stopId);
};

test('배송 완료는 도착과 현재 배송지의 필수 요청 ID 전체를 요구한다', () => {
  const sim = new OperatingSimulation(() => {});
  const required = ['S4-refrigerator', 'S4-handoff'];

  assert.equal(sim.setScenario('shipping', 'S4'), true);
  assert.equal(sim.completeCurrentStop(required), false, '미도착 완료 거절');
  arrive(sim, 'S4');

  const before = sim.snapshot();
  const eventCount = sim.events.length;
  for (const ids of [
    undefined,
    [],
    ['S4-refrigerator'],
    ['S4-refrigerator', 'S4-refrigerator'],
    ['S1-refrigerator', 'S4-handoff'],
    [...required, 'S5-refrigerator'],
  ]) {
    assert.equal(sim.completeCurrentStop(ids), false);
    const state = sim.snapshot();
    assert.equal(state.order.find(stop => stop.id === 'S4').status, 'current');
    assert.equal(state.events.length, eventCount);
  }

  assert.equal(sim.completeCurrentStop(required), true);
  const completed = sim.snapshot();
  assert.equal(completed.order.find(stop => stop.id === 'S4').status, 'done');
  const newEvents = sim.events.slice(eventCount);
  assert.deepEqual(newEvents.map(event => event.stopId), ['S4', 'S4']);
  assert.deepEqual(newEvents.map(event => event.action), ['requests_confirmed', 'completed']);
});

test('명시적으로 요청이 없는 S5는 빈 확인 목록으로 완료된다', () => {
  const sim = new OperatingSimulation(() => {});
  arrive(sim, 'S5');
  const eventCount = sim.events.length;

  assert.equal(sim.completeCurrentStop([]), true);
  const state = sim.snapshot();
  assert.equal(state.order.find(stop => stop.id === 'S5').status, 'done');
  const newEvents = sim.events.slice(eventCount);
  assert.equal(newEvents.some(event => event.action === 'requests_confirmed'), false);
  assert.deepEqual(newEvents.map(event => event.stopId), ['S5']);
});

test('예시 요청은 미등록과 빈 요청을 구분하고 매 호출마다 새 객체를 반환한다', () => {
  assert.equal(exampleRequestsFor('unknown'), null);
  assert.deepEqual(exampleRequestsFor('S5'), { source: 'example', items: [] });

  const first = exampleRequestsFor('S4');
  const second = exampleRequestsFor('S4');
  assert.notEqual(first, second);
  assert.notEqual(first.items, second.items);
  assert.notEqual(first.items[0], second.items[0]);
  first.items[0].label = '변경됨';
  first.items.push({ id: 'extra' });
  assert.deepEqual(second, {
    source: 'example',
    items: [
      { id: 'S4-refrigerator', kind: 'refrigerator', label: '매장 냉장고 안에 보관', required: true },
      { id: 'S4-handoff', kind: 'handoff', label: '매장 담당자에게 직접 전달', required: true },
    ],
  });
});
