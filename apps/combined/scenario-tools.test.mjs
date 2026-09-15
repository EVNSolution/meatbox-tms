import test from 'node:test';
import assert from 'node:assert/strict';
import { canSetScenario, nextScenarioTarget, scenarioSelectionState, selectedScenarioTarget } from './scenario-tools.mjs';

const live = { id: 'S1', vehicleId: 'V1', vehicle: { live: true } };
const synthetic = { id: 'V2-S1', vehicleId: 'V2', vehicle: { live: false } };
const state = { customerStopId: 'S1', fleetDeliveries: [live, synthetic] };

test('선택 배송은 전체 fleet에서 찾고 기본 고객 배송을 유지한다', () => {
  assert.equal(selectedScenarioTarget(state, undefined), live);
  assert.equal(selectedScenarioTarget(state, 'V2-S1'), synthetic);
  assert.equal(selectedScenarioTarget(state, 'missing'), null);
});

test('실시간 V1 배송만 시나리오 변경 대상으로 허용한다', () => {
  assert.equal(canSetScenario(live), true);
  assert.equal(canSetScenario(synthetic), false);
  assert.equal(canSetScenario({ id: 'V2-S1', vehicleId: 'V1' }), true);
  assert.equal(canSetScenario({ id: 'S1', vehicleId: 'V1', vehicle: { live: false } }), false);
  assert.equal(canSetScenario(null), false);
});

test('선택 배송과 preset 대상이 다르면 헤더와 버튼 활성 상태를 함께 중립화한다', () => {
  const s5 = { id: 'S5', vehicleId: 'V1', vehicle: { live: true } };
  const s6 = { id: 'S6', vehicleId: 'V1', vehicle: { live: true } };
  const current = { scenarioPreset: 'shipping', scenarioStopId: 'S5' };
  assert.deepEqual(scenarioSelectionState(current, s5, true), { activeScenario: 'shipping', controllable: true, status: '배송 중' });
  assert.deepEqual(scenarioSelectionState(current, s6, true), { activeScenario: null, controllable: true, status: '상태 선택' });
  assert.deepEqual(scenarioSelectionState(current, synthetic, true), { activeScenario: null, controllable: false, status: '조회 전용' });
});

const stop = id => ({ id, vehicleId: 'V1', vehicle: { live: true } });

test('다음 배송지는 ID 순서 대신 현재 배차 순서로 선택하고 상태를 바꾸지 않는다', () => {
  const route = [stop('S1'), { ...stop('S3'), status: 'skipped' }, stop('S2')];
  const current = { customerStopId: 'S1', deliveries: route, fleetDeliveries: [...route, synthetic] };
  const before = structuredClone(current);
  assert.equal(nextScenarioTarget(current, undefined), route[1]);
  assert.equal(nextScenarioTarget(current, 'S3'), route[2]);
  assert.equal(nextScenarioTarget(current, 'S2'), null);
  assert.equal(nextScenarioTarget(current, 'missing'), null);
  assert.equal(nextScenarioTarget(current, synthetic.id), null);
  assert.deepEqual(current, before);
});

test('순서가 없거나 다음 항목이 다른 차량이면 다음 배송지로 넘기지 않는다', () => {
  assert.equal(nextScenarioTarget(null, 'S1'), null);
  assert.equal(nextScenarioTarget(state, 'S1'), null);
  const route = [live, synthetic];
  assert.equal(nextScenarioTarget({ deliveries: route }, 'S1'), null);
  assert.equal(nextScenarioTarget({ deliveries: [live, { ...stop('S2'), vehicleId: 'V2' }] }, 'S1'), null);
});


test('과거와 미확정 날짜는 시나리오 변경과 다음 배송지 진행을 막는다', () => {
  const stop = { id: 'O1', vehicleId: 'G1', vehicle: { live: true } };
  for (const dispatch of [{ phase: 'published', readOnly: true }, { phase: 'draft', readOnly: false }, { phase: 'unplanned', readOnly: false }]) {
    const value = { dispatch, customerStopId: 'O1', fleetDeliveries: [stop], deliveries: [stop] };
    assert.equal(scenarioSelectionState(value, stop, true).controllable, false);
    assert.equal(nextScenarioTarget(value, 'O1'), null);
  }
});

test('수정안 작성 중에도 확정 차량의 시나리오와 다음 배송지를 사용할 수 있다', () => {
  const route = [stop('O1'), stop('O2')];
  const state = { dispatch: { phase: 'amending' }, fleetDeliveries: route, deliveries: route };
  assert.equal(scenarioSelectionState(state, route[0], true).controllable, true);
  assert.equal(nextScenarioTarget(state, 'O1'), route[1]);
});
