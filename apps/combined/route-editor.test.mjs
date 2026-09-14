import test from 'node:test';
import assert from 'node:assert/strict';
import { movePendingOrder } from './route-editor.mjs';

test('draft movement preserves locked slots and leaves the source route untouched', () => {
  const order = ['S1', 'S2', 'S3', 'S4', 'S5'];
  const deliveries = order.map((id, index) => ({ id, status: ['done', 'current', 'pending', 'skipped', 'pending'][index] }));
  assert.deepEqual(movePendingOrder(order, deliveries, 'S5', 'S3'), ['S1', 'S2', 'S5', 'S4', 'S3']);
  assert.deepEqual(movePendingOrder(order, deliveries, 'S2', 'S3'), order);
  assert.deepEqual(movePendingOrder(order, deliveries, 'S5', 'S1'), order);
  assert.deepEqual(order, ['S1', 'S2', 'S3', 'S4', 'S5']);
});
