import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioGroups, scenarioGuide, scenarioId } from './scenario-guide.mjs';

test('시나리오는 주문과 배송 두 그룹의 여섯 프리셋만 제공한다', () => {
  assert.deepEqual(scenarioGroups, [
    { label: '주문 관련', scenarios: [
      { id: 'received', label: '접수 완료' },
      { id: 'picking', label: '피킹 중' },
      { id: 'ready', label: '출고 준비' },
    ] },
    { label: '배송 관련', scenarios: [
      { id: 'shipping', label: '배송 중' },
      { id: 'arrived', label: '배송지 도착' },
      { id: 'completed', label: '배송 완료' },
    ] },
  ]);
});

test('현재 프리셋은 시간이나 다음 단계 없이 상태 이름만 반환한다', () => {
  assert.deepEqual(scenarioGuide({ scenario: 'arrived' }), { scenario: 'arrived', title: '배송지 도착' });
  assert.equal(scenarioId({ scenario: 'unknown', phase: 'delivering', truck: { dwelling: false } }), 'shipping');
  assert.equal(scenarioId({ phase: 'delivering', truck: { dwelling: true } }), 'arrived');
  assert.equal(scenarioId({ phase: 'done' }), 'completed');
  assert.equal(scenarioId({ scenarioPreset: null, phase: 'delivering', truck: { dwelling: false } }), null);
  assert.deepEqual(scenarioGuide({ scenarioPreset: null }), { scenario: null, title: '상태 미확인' });
  assert.equal(scenarioGuide(null), null);
});

test('기존 스냅샷도 여섯 프리셋 중 하나로만 해석한다', () => {
  assert.equal(scenarioId({ phase: 'unordered' }), 'received');
  assert.equal(scenarioId({ phase: 'idle' }), 'received');
  assert.equal(scenarioId({ phase: 'preparing', nextStep: { key: 'labeling' } }), 'picking');
  assert.equal(scenarioId({ phase: 'preparing', nextStep: { key: 'staged' } }), 'ready');
});
