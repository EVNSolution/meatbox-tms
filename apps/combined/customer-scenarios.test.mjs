import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerScenarios, randomCustomerPosition } from './customer-scenarios.mjs';
import { customerMapView, customerViewerDeliveries } from './customer-renderer.mjs';
import { nextScenarioTarget, scenarioSelectionState } from './scenario-tools.mjs';
import { sourceVehicleContext } from './source-context.mjs';

function fixture() {
  return { sourceData: { date: '2026-09-16' }, dispatch: { phase: 'unplanned', readOnly: false },
    fleetDeliveries: [], fleetVehicles: [], vehicleStates: {}, simClock: '06:00',
    dispatchOrders: [
      { id: 'A', name: '매장 A', coordinates: [127.1, 37.5], boxes: 4, notices: [] },
      { id: 'B', name: '매장 B', coordinates: [127.2, 37.6], boxes: 2, notices: [] },
      { id: 'C', name: '좌표 없는 매장', coordinates: null, boxes: 3, notices: [] },
    ],
  };
}

test('고객 시연은 미확정 주문에 예시 위치를 표시하고 서버 원본을 변경하지 않는다', () => {
  const source = fixture(), before = structuredClone(source);
  const scenarios = createCustomerScenarios({ random: () => 0.5 });
  const orders = customerViewerDeliveries(source);
  const view = scenarios.view(source, orders, 'A');
  const target = customerViewerDeliveries(view)[0];
  assert.equal(target.dispatchPending, true);
  assert.equal(target.vehicleId, undefined);
  assert.notDeepEqual(customerMapView(target, view).truck, target.coordinates);
  assert.deepEqual(customerMapView(target, view).truck, scenarios.view(source, orders, 'A').deliveries[0].customerDemo.truck);
  assert.equal(scenarioSelectionState(view, target, true).controllable, true);
  assert.equal(nextScenarioTarget(view, 'A').id, 'B');
  assert.equal(sourceVehicleContext(view, 'A'), view);
  assert.deepEqual(source, before);
});

test('여섯 단계는 선택 매장의 상태·시각·알림·위치를 함께 바꾸고 완료 후 재시연한다', () => {
  const source = fixture(), before = structuredClone(source);
  const orders = customerViewerDeliveries(source), scenarios = createCustomerScenarios();
  for (const scenario of ['received', 'picking', 'ready', 'shipping', 'arrived', 'completed']) {
    assert.equal(scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario }), true);
    const view = scenarios.view(source, orders, 'A'), delivery = view.deliveries[0];
    assert.equal(view.scenarioPreset, scenario);
    assert.equal(delivery.customerStatus.key, scenario);
    assert.equal(delivery.notices.at(-1).kind, scenario);
    assert.equal(delivery.timeline.find(item => item.label === delivery.customerStatus.label).time, view.simClock);
    assert.equal(delivery.dispatchPending, false);
    assert.equal(view.deliveries[1], orders[1]);
    if (scenario === 'arrived') assert.deepEqual(customerMapView(delivery, view).truck, delivery.coordinates);
    if (scenario === 'completed') {
      assert.equal(delivery.status, 'done');
      assert.equal(delivery.completedAt, view.simClock);
      assert.equal(customerMapView(delivery, view).truck, null);
    }
    assert.equal(scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario }), false);
  }
  assert.equal(scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'shipping' }), true);
  assert.ok(scenarios.view(source, orders, 'A').deliveries[0].customerDemo.truck);
  assert.deepEqual(source, before);
});

test('차량 위치는 명시적 요청에서만 바뀌고 도착·완료 또는 좌표가 없으면 변경하지 않는다', () => {
  const source = fixture(), orders = customerViewerDeliveries(source);
  let random = 0;
  const scenarios = createCustomerScenarios({ random: () => (random += 0.1) % 1 });
  const position = () => scenarios.view(source, orders, 'A').deliveries[0].customerDemo.truck;
  const first = position();
  assert.deepEqual(position(), first);
  assert.equal(scenarios.command(source, orders, 'randomize_customer_position', { stopId: 'A' }), true);
  assert.notDeepEqual(position(), first);
  for (const scenario of ['arrived', 'completed']) {
    scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario });
    assert.equal(scenarios.command(source, orders, 'randomize_customer_position', { stopId: 'A' }), false);
  }
  assert.equal(scenarios.command(source, orders, 'randomize_customer_position', { stopId: 'C' }), false);
  assert.deepEqual(customerMapView(scenarios.view(source, orders, 'C').deliveries[2], scenarios.view(source, orders, 'C')), { home: null, road: [], truck: null });
  for (const input of [null, [], [NaN, 37], [127], [190, 37], [127, 90]]) assert.equal(randomCustomerPosition(input), null);
});

test('매장 전환·초기화·운영일 변경은 시연 상태를 서로 섞지 않는다', () => {
  const source = fixture(), orders = customerViewerDeliveries(source), scenarios = createCustomerScenarios();
  scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'completed' });
  assert.equal(scenarios.view(source, orders, 'B').scenarioPreset, null);
  assert.equal(scenarios.view(source, orders, 'A').scenarioPreset, 'completed');
  scenarios.command(source, orders, 'reset_customer_demo', { stopId: 'A' });
  const reset = scenarios.view(source, orders, 'A');
  assert.equal(reset.scenarioPreset, null);
  assert.equal(reset.deliveries[0].dispatchPending, true);
  assert.deepEqual(reset.deliveries[0].notices, []);
  scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'shipping' });
  const otherDay = { ...source, sourceData: { date: '2026-09-17' } };
  assert.equal(scenarios.view(otherDay, orders, 'A').scenarioPreset, null);
  assert.equal(scenarios.command(source, orders, 'set_scenario', { stopId: 'missing', scenario: 'shipping' }), false);
  assert.equal(scenarios.command(source, orders, 'publish_dispatch', { stopId: 'A' }), false);
});

test('과거 날짜와 기존 예제 시뮬레이션에는 고객 시연을 주입하지 않는다', () => {
  const source = fixture(), orders = customerViewerDeliveries(source), scenarios = createCustomerScenarios();
  for (const state of [{ ...source, dispatch: { phase: 'published', readOnly: true } }, { deliveries: orders }]) {
    assert.equal(scenarios.view(state, orders, 'A'), state);
    assert.equal(scenarios.command(state, orders, 'set_scenario', { stopId: 'A', scenario: 'completed' }), false);
  }
});

test('과거 날짜를 보고 돌아오면 시연을 초기화하며 새 페이지의 알림 ID는 재사용하지 않는다', () => {
  const source = fixture(), orders = customerViewerDeliveries(source), scenarios = createCustomerScenarios();
  scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'shipping' });
  const oldId = scenarios.view(source, orders, 'A').deliveries[0].notices[0].id;
  scenarios.view({ ...source, sourceData: { date: '2026-09-15' }, dispatch: { readOnly: true } }, orders, 'A');
  assert.equal(scenarios.view(source, orders, 'A').scenarioPreset, null);
  const reloaded = createCustomerScenarios();
  reloaded.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'shipping' });
  assert.notEqual(reloaded.view(source, orders, 'A').deliveries[0].notices[0].id, oldId);
});

test('확정 배차의 원래 도착·완료 상태와 ETA는 시연 전 및 초기화 후 보존한다', () => {
  const source = fixture();
  source.dispatch.phase = 'published';
  source.fleetDeliveries = [{ ...source.dispatchOrders[0], vehicleId: 'G1', status: 'current', arrivedAt: '10:30', customerWindowText: '10:00 ~ 11:00' }];
  const before = structuredClone(source), orders = customerViewerDeliveries(source), scenarios = createCustomerScenarios();
  let preview = scenarios.view(source, orders, 'A');
  assert.deepEqual(preview.deliveries[0].customerDemo.truck, orders[0].coordinates);
  assert.equal(preview.deliveries[0].customerWindowText, '10:00 ~ 11:00');
  scenarios.command(source, orders, 'set_scenario', { stopId: 'A', scenario: 'shipping' });
  preview = scenarios.view(source, orders, 'A');
  assert.equal(preview.deliveries[0].arrivedAt, null);
  assert.equal(preview.deliveries[0].customerWindowText, '06:20 ~ 07:20');
  scenarios.command(source, orders, 'reset_customer_demo', { stopId: 'A' });
  assert.equal(scenarios.view(source, orders, 'A').deliveries[0].arrivedAt, '10:30');
  assert.equal(scenarios.view(source, orders, 'A').deliveries[0].customerWindowText, '10:00 ~ 11:00');
  assert.deepEqual(source, before);
});
