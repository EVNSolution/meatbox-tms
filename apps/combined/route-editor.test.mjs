import test from 'node:test';
import assert from 'node:assert/strict';
import { movePendingOrder, routeEditability, routeSelectionId, mountRouteEditor } from './route-editor.mjs';

const target = matches => ({ closest: selector => matches[selector] || null });

test('draft movement preserves locked slots and leaves the source route untouched', () => {
  const order = ['S1', 'S2', 'S3', 'S4', 'S5'];
  const deliveries = order.map((id, index) => ({ id, status: ['done', 'current', 'pending', 'skipped', 'pending'][index] }));
  assert.deepEqual(movePendingOrder(order, deliveries, 'S5', 'S3'), ['S1', 'S2', 'S5', 'S4', 'S3']);
  assert.deepEqual(movePendingOrder(order, deliveries, 'S2', 'S3'), order);
  assert.deepEqual(movePendingOrder(order, deliveries, 'S5', 'S1'), order);
  assert.deepEqual(order, ['S1', 'S2', 'S3', 'S4', 'S5']);
});

test('only the live vehicle route can be edited', () => {
  assert.equal(routeEditability({vehicle:{id:'V1',live:true}}).editable, true);
  assert.deepEqual(routeEditability({vehicle:{id:'V2',live:false}}), {
    editable:false,
    reason:'조회 전용 차량은 배송 순서를 편집할 수 없습니다.',
  });
});

test('60-stop routes keep locked stops fixed when the final delivery moves to the front of the pending queue', () => {
  const order = Array.from({ length: 60 }, (_, i) => `S${i + 1}`);
  const deliveries = order.map((id, i) => ({ id, status: ['done', 'current', 'skipped'][i] || 'pending' }));
  const moved = movePendingOrder(order, deliveries, 'S60', 'S4');
  assert.deepEqual(moved.slice(0, 5), ['S1', 'S2', 'S3', 'S60', 'S4']);
  assert.equal(new Set(moved).size, 60);
  assert.equal(moved.at(-1), 'S59');
  assert.equal(order.at(-1), 'S60');
});

test('route row background and number select their containing stop', () => {
  const row = { dataset: { routeId: 'S3' } };
  const element = { contains: node => node === row };
  const background = target({ '[data-route-id]': row });
  const number = target({ '[data-route-id]': row });
  assert.equal(routeSelectionId(element, background), 'S3');
  assert.equal(routeSelectionId(element, number), 'S3');
});

test('route select button selects once while action and drag buttons do not fall through', () => {
  const row = { dataset: { routeId: 'S3' } };
  const select = { dataset: { routeSelect: 'S3' } };
  const element = { contains: node => node === row || node === select };
  assert.equal(routeSelectionId(element, target({ '[data-route-select]': select, button: select, '[data-route-id]': row })), 'S3');
  assert.equal(routeSelectionId(element, target({ button: {}, '[data-route-id]': row })), null);
  assert.equal(routeSelectionId(element, target({ '[data-route-id]': { dataset: { routeId: 'outside' } } })), null);
});

function editorFixture() {
  globalThis.document = { activeElement: null };
  const listeners = {}, sent = [], cancelled = [], list = { scrollTop: 0 };
  const element = { innerHTML: '', contains: () => false, querySelector: selector => selector === '.route-list' ? list : null,
    addEventListener: (type, listener) => { listeners[type] = listener; } };
  const editor = mountRouteEditor({ element, onSend: (...args) => sent.push(args), onSelect() {}, onCancel: () => cancelled.push(true) });
  const click = matches => listeners.click({ target: target(matches) });
  const action = name => click({ '[data-route-action]': { dataset: { routeAction: name } } });
  return { element, editor, click, action, sent, cancelled };
}
const editableState = () => ({ phase: 'shipping', vehicle: { id: 'V1', live: true }, customerStopId: 'S1', deliveries: [
  { id: 'S1', name: '현재', status: 'current' }, { id: 'S2', name: '대기 2', status: 'pending' }, { id: 'S3', name: '대기 3', status: 'pending' },
] });

test('direct route entry starts editing once and preserves the moved draft on re-entry', () => {
  const { editor, element, click, action, sent } = editorFixture();
  const state = editableState();
  editor.update(state, 'S1', true);
  editor.beginEdit();
  assert.match(element.innerHTML, /data-route-action="cancel"/);
  assert.doesNotMatch(element.innerHTML, /data-route-action="edit"/);
  assert.match(element.innerHTML, /data-handle="S1"[^>]*disabled/);
  click({ '[data-move]': { dataset: { move: 'S2', direction: '1' } } });
  const draftMarkup = element.innerHTML;
  editor.beginEdit();
  assert.equal(element.innerHTML, draftMarkup);
  assert.deepEqual(sent, []);
  action('save');
  assert.deepEqual(sent, [['set_route_order', { order: ['S1', 'S3', 'S2'], expectedOrder: ['S1', 'S2', 'S3'], expectedStatuses: ['current', 'pending', 'pending'], expectedPhase: 'shipping' }]]);
});

test('direct entry retains cancel, stale-state and read-only protections', () => {
  const { editor, element, click, action, sent } = editorFixture();
  const state = editableState();
  editor.update(state, 'S1', true);
  editor.beginEdit();
  click({ '[data-move]': { dataset: { move: 'S2', direction: '1' } } });
  action('cancel');
  assert.deepEqual(sent, []);
  assert.ok(element.innerHTML.indexOf('data-route-id="S2"') < element.innerHTML.indexOf('data-route-id="S3"'));
  editor.beginEdit();
  editor.update({ ...state, phase: 'completed' }, 'S1', true);
  assert.doesNotMatch(element.innerHTML, /data-route-action="save"/);
  for (const [next, connected] of [[state, false], [{ ...state, vehicle: { id: 'V2', live: false } }, true], [{ ...state, deliveries: state.deliveries.slice(0, 2) }, true]]) {
    editor.update(next, 'S1', connected);
    editor.beginEdit();
    assert.doesNotMatch(element.innerHTML, /data-route-action="save"/);
  }
  assert.deepEqual(sent, []);
});

const moveSecond = click => click({ '[data-move]': { dataset: { move: 'S2', direction: '1' } } });
const renderedOrder = element => [...element.innerHTML.matchAll(/data-route-id="([^"]+)"/g)].map(match => match[1]);

test('reset discards only unsaved moves, stays editable and sends no command', () => {
  const { editor, element, click, action, sent, cancelled } = editorFixture();
  const state = editableState(), before = structuredClone(state);
  editor.update(state, 'S1', true);
  editor.beginEdit();
  moveSecond(click);
  action('reset');
  assert.deepEqual(renderedOrder(element), ['S1', 'S2', 'S3']);
  assert.match(element.innerHTML, /data-route-action="save"[^>]*disabled/);
  assert.match(element.innerHTML, /data-handle="S2"/);
  assert.deepEqual(sent, []);
  assert.deepEqual(cancelled, []);
  assert.deepEqual(state, before);
});

test('save acknowledgment stays editable and reset uses the last saved order', () => {
  const { editor, element, click, action, sent, cancelled } = editorFixture();
  const state = editableState();
  editor.update(state, 'S1', true);
  editor.beginEdit();
  moveSecond(click);
  action('save');
  action('cancel');
  action('reset');
  assert.deepEqual(cancelled, []);
  assert.equal(sent.length, 1);
  const saved = { ...state, deliveries: [state.deliveries[0], state.deliveries[2], state.deliveries[1]] };
  editor.update(saved, 'S1', true);
  assert.match(element.innerHTML, /data-handle="S2"/);
  assert.match(element.innerHTML, /data-route-action="save"[^>]*disabled/);
  assert.doesNotMatch(element.innerHTML, /data-route-action="edit"/);
  assert.deepEqual(cancelled, []);
  click({ '[data-move]': { dataset: { move: 'S2', direction: '-1' } } });
  action('reset');
  assert.deepEqual(renderedOrder(element), ['S1', 'S3', 'S2']);
  assert.equal(sent.length, 1);
  click({ '[data-move]': { dataset: { move: 'S2', direction: '-1' } } });
  action('save');
  assert.deepEqual(sent[1][1].expectedOrder, ['S1', 'S3', 'S2']);
});

test('cancel discards the draft and invokes return even for a read-only route', () => {
  const { editor, element, click, action, sent, cancelled } = editorFixture();
  const state = editableState();
  editor.update(state, 'S1', true);
  editor.beginEdit();
  moveSecond(click);
  action('cancel');
  assert.deepEqual(renderedOrder(element), ['S1', 'S2', 'S3']);
  assert.equal(cancelled.length, 1);
  assert.deepEqual(sent, []);
  editor.update({ ...state, vehicle: { id: 'V2', live: false } }, 'S1', true);
  assert.match(element.innerHTML, /data-route-action="cancel"/);
  action('cancel');
  assert.equal(cancelled.length, 2);
});
