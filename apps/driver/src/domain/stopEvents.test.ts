import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FleetDelivery } from './dispatch';
import { buildStopEvent, draftProblem, NOTE_MAX, partialItemsFor, REASON_CODES, type StopDraft } from './stopEvents';

const order = (id: string, items: FleetDelivery['items']): FleetDelivery => ({
  id, vehicleId: 'G1', name: '가게', address: '서울', boxes: 1, sequence: 1, status: 'current', items,
});

test('the six reason codes match the server', () => {
  assert.deepEqual(REASON_CODES.map((reason) => reason.code), ['ABSENT', 'ACCESS_DENIED', 'ADDRESS_MISMATCH', 'REFUSED', 'NO_STORAGE', 'OTHER']);
});

test('a completion carries the stop and a trimmed note only when there is one', () => {
  assert.deepEqual(buildStopEvent('O1', { kind: 'completed', note: '' }, 'O1'), { type: 'stop_completed', payload: { stopId: 'O1' } });
  assert.deepEqual(buildStopEvent('O1', { kind: 'completed', note: '  문 앞  ' }, 'O1'), {
    type: 'stop_completed', payload: { stopId: 'O1', note: '문 앞' },
  });
});

test('a failure needs a reason code; the note is optional', () => {
  assert.equal(draftProblem({ kind: 'failed', reasonCode: null, note: '' }, 0, true), '미배송 사유를 선택해 주세요.');
  assert.deepEqual(buildStopEvent('O1', { kind: 'failed', reasonCode: 'ABSENT', note: '부재' }, 'O1'), {
    type: 'stop_failed', payload: { stopId: 'O1', reasonCode: 'ABSENT', note: '부재' },
  });
  assert.throws(() => buildStopEvent('O1', { kind: 'failed', reasonCode: null, note: '' }, 'O1'));
});

test('a partial delivery lists every item with ordered and delivered quantities for its single order', () => {
  const items = partialItemsFor([order('O1', [{ sku: 'S1', name: '삼겹살', qty: 3 }, { sku: 'S2', qty: 2 }])]);
  assert.deepEqual(items, [
    { sku: 'S1', name: '삼겹살', orderedQty: 3, deliveredQty: 3 },
    { sku: 'S2', name: 'S2', orderedQty: 2, deliveredQty: 2 },
  ]);
  const draft: StopDraft = { kind: 'partial', items: [{ ...items![0], deliveredQty: 1 }, items![1]], note: '' };
  assert.deepEqual(buildStopEvent('O1', draft, 'O1'), {
    type: 'stop_partially_completed',
    payload: { stopId: 'O1', orderId: 'O1', items: [{ sku: 'S1', deliveredQty: 1, orderedQty: 3 }, { sku: 'S2', deliveredQty: 2, orderedQty: 2 }] },
  });
});

test('partial delivery is refused for several orders, no items, equal quantities and out-of-range quantities', () => {
  assert.equal(partialItemsFor([order('O1', [{ sku: 'S1', qty: 1 }]), order('O2', [{ sku: 'S1', qty: 1 }])]), null);
  assert.equal(partialItemsFor([order('O1', [])]), null);
  assert.equal(partialItemsFor([order('O1', null)]), null);
  assert.equal(partialItemsFor([order('O1', [{ sku: ' ', qty: 1 }, { sku: 'S', qty: 0 }])]), null);
  const base = { sku: 'S1', name: 'S1', orderedQty: 3, deliveredQty: 3 };
  assert.match(draftProblem({ kind: 'partial', items: [base], note: '' }, 0, true) ?? '', /완료로/u);
  assert.match(draftProblem({ kind: 'partial', items: [{ ...base, deliveredQty: 4 }], note: '' }, 0, true) ?? '', /수량/u);
  assert.match(draftProblem({ kind: 'partial', items: [{ ...base, deliveredQty: -1 }], note: '' }, 0, true) ?? '', /수량/u);
  assert.match(draftProblem({ kind: 'partial', items: [], note: '' }, 0, true) ?? '', /수량/u);
  assert.equal(draftProblem({ kind: 'partial', items: [{ ...base, deliveredQty: 0 }], note: '' }, 0, true), null);
});

test('a completion needs a photo when the policy says so, and a note has a length limit', () => {
  assert.match(draftProblem({ kind: 'completed', note: '' }, 0, true) ?? '', /1장/u);
  assert.equal(draftProblem({ kind: 'completed', note: '' }, 1, true), null);
  assert.equal(draftProblem({ kind: 'completed', note: '' }, 0, false), null);
  assert.match(draftProblem({ kind: 'completed', note: 'x'.repeat(NOTE_MAX + 1) }, 1, true) ?? '', /500자/u);
  assert.equal(draftProblem({ kind: 'completed', note: 'x'.repeat(NOTE_MAX) }, 1, true), null);
});
