import test from 'node:test';
import assert from 'node:assert/strict';
import { pages, pageFromHash, viewModel } from './view-model.mjs';
import { etaCard, customerCard, etaValue } from './view-components.mjs';
import { scenarioOptions } from './sample-data.mjs';

const base = { scenario: 'traffic', selectedId: 'TMS-004', query: '', status: 'all', changedOnly: false };

test('page navigation preserves the same selection and scenario result', () => {
  for (const page of Object.keys(pages)) {
    const state = { ...base, page };
    assert.equal(pageFromHash(`#/${page}`), page);
    assert.equal(viewModel(state).selected.id, 'TMS-004');
    assert.equal(viewModel(state).selected.etaStatus, 'stale');
    assert.deepEqual(state, { ...base, page });
  }
  assert.equal(pageFromHash('#/missing'), 'control');
  assert.equal(pageFromHash('#page-heading'), 'control');
});

test('combined filters and counts use one result without mutating the input', () => {
  assert.equal(viewModel({ ...base, changedOnly: true }).visible.length, 1);
  const empty = viewModel({ ...base, status: 'completed', changedOnly: true });
  assert.equal(empty.visible.length, 0);
  assert.equal(empty.selected, null);
  assert.equal(viewModel(base).selected.id, 'TMS-004');
});

test('shared cards preserve ETA meanings and heading IDs across all scenario samples', () => {
  for (const option of scenarioOptions) {
    const terminal = viewModel({ ...base, scenario: option.id, selectedId: 'TMS-001' }).selected;
    const value = etaValue(terminal);
    assert.ok(etaCard(terminal, `guide-${option.id}`).includes(value));
    assert.ok(customerCard(terminal).includes(value));
    assert.ok(etaCard(terminal, `guide-${option.id}`).includes(`id="guide-${option.id}"`));
    if (option.id === 'stale') assert.ok(customerCard(terminal).includes('최신 도착 시간 확인 중'));
    if (option.id === 'completed') assert.equal(value, '13:42 완료');
    if (option.id === 'preparing') assert.equal(value, '확인 중');
  }
});
