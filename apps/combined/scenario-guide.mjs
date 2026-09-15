export const scenarioGroups = [
  {
    label: '주문 관련',
    scenarios: [
      { id: 'received', label: '접수 완료' },
      { id: 'picking', label: '피킹 중' },
      { id: 'ready', label: '출고 준비' },
    ],
  },
  {
    label: '배송 관련',
    scenarios: [
      { id: 'shipping', label: '배송 중' },
      { id: 'arrived', label: '배송지 도착' },
      { id: 'completed', label: '배송 완료' },
    ],
  },
];

const scenarios = scenarioGroups.flatMap(group => group.scenarios);
const validScenarios = new Set(scenarios.map(scenario => scenario.id));

export function scenarioId(state) {
  if (!state) return null;
  if (Object.hasOwn(state, 'scenarioPreset')) return validScenarios.has(state.scenarioPreset) ? state.scenarioPreset : null;
  const explicit = state.scenario;
  if (validScenarios.has(explicit)) return explicit;
  if (state.phase === 'done') return 'completed';
  if (state.phase === 'delivering') return state.truck?.dwelling ? 'arrived' : 'shipping';
  if (state.phase === 'preparing') return state.nextStep?.key === 'labeling' ? 'picking' : 'ready';
  if (state.phase === 'idle' || state.phase === 'unordered') return 'received';
  return null;
}

export function scenarioGuide(state) {
  if (!state) return null;
  const id = scenarioId(state);
  if (!id) return { scenario: null, title: '상태 미확인' };
  const selected = scenarios.find(scenario => scenario.id === id);
  return { scenario: selected.id, title: selected.label };
}
