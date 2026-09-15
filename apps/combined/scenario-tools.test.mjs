import test from 'node:test';
import assert from 'node:assert/strict';
import { canSetScenario, scenarioSelectionState, selectedScenarioTarget } from './scenario-tools.mjs';

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
