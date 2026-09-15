import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchWorkflowModel, mountDispatchWorkflow } from './dispatch-workflow.mjs';

class FakeNode {
  constructor(name = '') { this.name = name; this._innerHTML = ''; this.htmlWrites = 0; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.open = false; this.focused = false; this.listeners = {}; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = value; this.htmlWrites += 1; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}

function fixture() {
  const names = ['phase', 'open', 'discard', 'publish', 'summary', 'notice', 'dialog', 'close', 'search', 'selected', 'all', 'clear', 'candidates', 'preview', 'error', 'help', 'calculate'];
  const nodes = Object.fromEntries(names.map(name => [name, new FakeNode(name)]));
  const selectors = Object.fromEntries(names.map(name => [`[data-dispatch-${name}]`, name]));
  const element = new FakeNode('root');
  element.querySelector = selector => nodes[selectors[selector]];
  return { element, nodes };
}

function data(overrides = {}) {
  return {
    sourceData: { date: '2026-09-16' },
    dispatch: { phase: 'unplanned', today: '2026-09-16', readOnly: false, candidateIds: ['V1'], draftVersion: null, confirmedVersion: null, summary: { orders: 10, destinations: 9, boxes: 20 }, canCalculate: true, canAmend: false, canPublish: false, hasChanges: false },
    dispatchCandidates: [
      { id: 'V1', driver: '김기사', plate: '11가 1111', region: '서울', locked: true },
      { id: 'V2', driver: '이기사', plate: '22나 2222', region: '인천' },
    ],
    dispatchPreview: [],
    ...overrides,
  };
}

function checkbox(id, checked, disabled = false) {
  return { closest: () => ({ dataset: { dispatchCandidate: id }, checked, disabled }) };
}

test('단계와 계산안, 전체 전송 가능 조건을 실제 상태에서만 만든다', () => {
  const draft = dispatchWorkflowModel(data({
    dispatch: { ...data().dispatch, phase: 'draft', draftVersion: 4, canPublish: true, hasChanges: true },
    dispatchPreview: [{ vehicleId: 'V1', orders: 6, destinations: 5, boxes: 12 }],
  }));
  assert.equal(draft.phaseLabel, '계산안');
  assert.equal(draft.canPublish, true);
  assert.equal(draft.preview[0].label, '김기사');
  assert.equal(dispatchWorkflowModel(data({ dispatch: { ...data().dispatch, phase: 'draft', draftVersion: null, canPublish: true } })).canPublish, false);
  assert.equal(dispatchWorkflowModel(data({ dispatch: { ...data().dispatch, phase: 'published', draftVersion: 4 } })).canPublish, false);
  assert.equal(dispatchWorkflowModel(data({ dispatch: { ...data().dispatch, readOnly: true } })).phaseLabel, '과거 배차 기록');
});

test('polling 갱신은 선택을 보존하고 계산은 선택한 배송원 ID만 전송한다', async () => {
  const { element, nodes } = fixture();
  const commands = [];
  const workflow = mountDispatchWorkflow({ element, onCommand: (...args) => { commands.push(args); } });
  workflow.update(data());
  assert.match(element.innerHTML, /배송원 뷰어에 확정 배차를 반영합니다/);
  assert.equal(nodes.summary.innerHTML, '<p class="dispatch-workflow-volume"><span>배차 대상</span><span>주문 10</span><span>배송지 9</span><span>20박스</span></p>');
  assert.match(nodes.candidates.innerHTML, /김기사/);
  assert.match(nodes.candidates.innerHTML, /data-dispatch-candidate="V1" checked disabled/);
  nodes.candidates.listeners.change({ target: checkbox('V2', true) });
  const candidateWrites = nodes.candidates.htmlWrites;
  workflow.update(data());
  assert.equal(nodes.selected.textContent, '2명 선택');
  assert.equal(nodes.candidates.htmlWrites, candidateWrites);
  nodes.calculate.listeners.click();
  assert.match(nodes.candidates.innerHTML, /data-dispatch-candidate="V2" checked disabled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [['calculate_dispatch', { vehicleIds: ['V1', 'V2'] }]]);
  workflow.destroy();
});

test('후보 또는 날짜 변경은 선택과 오류를 초기화하고 잠긴 후보는 유지한다', () => {
  const { element, nodes } = fixture();
  const workflow = mountDispatchWorkflow({ element, onCommand: () => Promise.reject(new Error('fail')) });
  workflow.update(data());
  nodes.candidates.listeners.change({ target: checkbox('V2', true) });
  workflow.update(data({
    sourceData: { date: '2026-09-17' },
    dispatchCandidates: [{ id: 'V3', driver: '박기사', plate: '33다 3333', locked: true }],
  }));
  assert.equal(nodes.selected.textContent, '1명 선택');
  assert.match(nodes.candidates.innerHTML, /data-dispatch-candidate="V3" checked disabled/);
  assert.equal(nodes.error.hidden, true);
  workflow.destroy();
});

test('과거 날짜는 열린 선택창을 닫고 계산과 전송을 막는다', () => {
  const { element, nodes } = fixture();
  const workflow = mountDispatchWorkflow({ element });
  workflow.update(data());
  nodes.open.listeners.click();
  assert.equal(nodes.dialog.open, true);
  workflow.update(data({ dispatch: { ...data().dispatch, readOnly: true, phase: 'published', confirmedVersion: 3 } }));
  assert.equal(nodes.dialog.open, false);
  assert.equal(nodes.phase.textContent, '과거 배차 기록');
  assert.equal(nodes.open.disabled, true);
  assert.equal(nodes.publish.disabled, true);
  workflow.destroy();
});

test('확정 배차는 과거 기록과 구분하고 후보 변경과 재계산을 막는다', () => {
  const { element, nodes } = fixture();
  const workflow = mountDispatchWorkflow({ element });
  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'published', confirmedVersion: 8 },
    dispatchPreview: [{ vehicleId: 'V1', orders: 10, destinations: 9, boxes: 20 }],
  }));
  assert.equal(nodes.phase.textContent, '배차 확정');
  assert.equal(nodes.help.textContent, '확정된 배차입니다');
  assert.equal(nodes.open.disabled, true);
  assert.equal(nodes.calculate.disabled, true);
  assert.match(nodes.preview.innerHTML, /확정 배차/);
  assert.doesNotMatch(nodes.candidates.innerHTML, / · /);
  workflow.destroy();
});

test('확정 배차는 수정안을 열고 변경을 다시 전송하거나 취소한다', async () => {
  const { element, nodes } = fixture();
  const commands = [];
  const workflow = mountDispatchWorkflow({ element, onCommand: (...args) => { commands.push(args); } });
  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'published', confirmedVersion: 8, canAmend: true },
    dispatchPreview: [{ vehicleId: 'V1', orders: 10, destinations: 9, boxes: 20 }],
  }));
  assert.equal(nodes.open.textContent, '배차 수정');
  assert.equal(nodes.open.disabled, false);
  nodes.open.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [['begin_dispatch_revision', {}]]);

  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'amending', draftVersion: 9, confirmedVersion: 8, candidateIds: ['V1'], canPublish: false, hasChanges: false },
    dispatchPreview: [{ vehicleId: 'V1', orders: 10, destinations: 9, boxes: 20 }],
  }));
  assert.equal(nodes.phase.textContent, '배차 수정안');
  assert.equal(nodes.discard.hidden, false);
  assert.equal(nodes.publish.textContent, '변경 배차 다시 전송');
  assert.equal(nodes.publish.disabled, true);
  assert.match(nodes.candidates.innerHTML, /data-dispatch-candidate="V1" checked disabled/);

  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'amending', draftVersion: 10, confirmedVersion: 8, candidateIds: ['V1'], canPublish: true, hasChanges: true },
    dispatchPreview: [{ vehicleId: 'V1', orders: 10, destinations: 9, boxes: 20 }],
  }));
  nodes.publish.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands.at(-1), ['publish_dispatch', { draftVersion: 10 }]);
  assert.match(nodes.notice.innerHTML, /변경 배차를 다시 전송했습니다/);
  assert.match(nodes.notice.innerHTML, /driver\.html\?date=2026-09-16/);

  nodes.discard.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands.at(-1), ['discard_dispatch_revision', {}]);
  workflow.destroy();
});

test('전송 중 후보가 잠겨도 요청을 취소하지 않고 성공 안내를 보여준다', async () => {
  const { element, nodes } = fixture();
  let finishPublish;
  const workflow = mountDispatchWorkflow({ element, onCommand: () => new Promise(resolve => { finishPublish = resolve; }) });
  const draftCandidates = [
    { id: 'V1', driver: '김기사', plate: '11가 1111', region: '서울', locked: false },
    { id: 'V2', driver: '이기사', plate: '22나 2222', region: '인천', locked: false },
  ];
  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'draft', candidateIds: ['V1'], draftVersion: 4, canPublish: true, hasChanges: true },
    dispatchCandidates: draftCandidates,
  }));
  nodes.publish.listeners.click();
  workflow.update(data({
    dispatch: { ...data().dispatch, phase: 'published', candidateIds: ['V1'], confirmedVersion: 4, canAmend: true },
    dispatchCandidates: draftCandidates.map(candidate => ({ ...candidate, locked: candidate.id === 'V1' })),
    dispatchPreview: [{ vehicleId: 'V1', orders: 10, destinations: 9, boxes: 20 }],
  }));
  assert.match(nodes.candidates.innerHTML, /data-dispatch-candidate="V1" checked disabled/);
  finishPublish();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.notice.innerHTML, /전체 배차를 전송했습니다/);
  assert.equal(nodes.notice.hidden, false);
  workflow.destroy();
});

test('계산 완료 후 결과 보기로 창을 닫고 서버 오류 문구를 바로 표시한다', async () => {
  const { element, nodes } = fixture();
  let failure = false;
  const workflow = mountDispatchWorkflow({ element, onCommand: () => failure ? Promise.reject(new Error('선택한 배송지는 이미 운행 중입니다.')) : Promise.resolve() });
  workflow.update(data());
  nodes.open.listeners.click();
  nodes.calculate.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.calculate.textContent, '계산 결과 보기');
  nodes.calculate.listeners.click();
  assert.equal(nodes.dialog.open, false);

  failure = true;
  workflow.update(data({ dispatch: { ...data().dispatch, phase: 'published', canAmend: true } }));
  nodes.open.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.notice.textContent, '선택한 배송지는 이미 운행 중입니다.');
  workflow.destroy();
});

test('기준이 없으면 계산을 정직하게 비활성화하고 draftVersion으로만 전체 전송한다', async () => {
  const { element, nodes } = fixture();
  const commands = [];
  const workflow = mountDispatchWorkflow({ element, onCommand: (...args) => { commands.push(args); } });
  workflow.update(data({ dispatch: { ...data().dispatch, canCalculate: false } }));
  assert.equal(nodes.calculate.disabled, true);
  assert.equal(nodes.help.textContent, '배차 계산 기준 확인 중');

  workflow.update(data({ dispatch: { ...data().dispatch, phase: 'draft', draftVersion: 7, canPublish: true, hasChanges: true } }));
  nodes.publish.listeners.click();
  assert.equal(nodes.publish.textContent, '전체 배차 전송 중…');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [['publish_dispatch', { draftVersion: 7 }]]);
  assert.equal(nodes.publish.textContent, '전체 배차 전송');
  workflow.destroy();
});

test('발표 명단은 9월16일 배차 전에만 초기 선택하고 수동 선택과 다른 날짜를 보존한다', async () => {
  const { presentationFleet } = await import('./dispatch-presentation.mjs');
  const candidates = presentationFleet.vehicleIds.map(id => ({ id, driver: id }));
  const source = data({ dispatch: { ...data().dispatch, candidateIds: [] }, dispatchCandidates: candidates });
  const { element, nodes } = fixture();
  const commands = [];
  const workflow = mountDispatchWorkflow({ element, onCommand: (...args) => commands.push(args) });
  workflow.update(source);
  assert.equal(nodes.selected.textContent, '80명 선택');
  assert.equal(commands.length, 0);
  nodes.clear.listeners.click();
  workflow.update(source);
  assert.equal(nodes.selected.textContent, '0명 선택');
  workflow.update({ ...source, sourceData: { date: '2026-09-17' } });
  assert.equal(nodes.selected.textContent, '0명 선택');
  workflow.update(source);
  assert.equal(nodes.selected.textContent, '80명 선택');
  nodes.calculate.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [['calculate_dispatch', { vehicleIds: presentationFleet.vehicleIds }]]);
  workflow.destroy();
});

test('발표 명단은 기존 계산·확정 후보와 불완전한 후보 자료에 적용하지 않는다', async () => {
  const { presentationFleet, presentationCandidateIds } = await import('./dispatch-presentation.mjs');
  const base = { date: presentationFleet.date, phase: 'unplanned', readOnly: false, candidateIds: [], candidates: presentationFleet.vehicleIds.map(id => ({ id })) };
  assert.equal(new Set(presentationFleet.vehicleIds).size, 80);
  for (const phase of ['draft', 'published', 'amending']) assert.deepEqual(presentationCandidateIds({ ...base, phase }), []);
  assert.deepEqual(presentationCandidateIds({ ...base, readOnly: true }), []);
  assert.deepEqual(presentationCandidateIds({ ...base, candidateIds: [presentationFleet.vehicleIds[0]] }), []);
  assert.deepEqual(presentationCandidateIds({ ...base, candidates: base.candidates.slice(1) }), []);
});
