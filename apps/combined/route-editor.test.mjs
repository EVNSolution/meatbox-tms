import test from 'node:test';
import assert from 'node:assert/strict';
import { movePendingOrder, routeEditability, routeSelectionId } from './route-editor.mjs';

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
