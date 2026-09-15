import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './pagination-model.mjs';
import { filterFleetDeliveries } from './operations-model.mjs';

test('delivery pagination limits the rendered rows and reports the full filtered range', () => {
  const result = paginate(Array.from({ length: 4550 }, (_, index) => index + 1), 2);
  assert.deepEqual(result.items, Array.from({ length: 50 }, (_, index) => index + 51));
  assert.deepEqual({ page: result.page, pageCount: result.pageCount, start: result.start, end: result.end, total: result.total },
    { page: 2, pageCount: 91, start: 51, end: 100, total: 4550 });
});

test('filter changes can reset to the first page and live updates clamp a preserved page', () => {
  const deliveries = Array.from({ length: 120 }, (_, index) => ({ id: `S${index + 1}`, status: index < 37 ? 'done' : 'pending' }));
  const filtered = paginate(filterFleetDeliveries(deliveries, { status: 'done' }), 1);
  const preserved = paginate(Array(120), 3);
  const clamped = paginate(Array(80), 3);
  const empty = paginate([], 8);
  assert.deepEqual({ page: filtered.page, rows: filtered.items.length }, { page: 1, rows: 37 });
  assert.deepEqual({ page: preserved.page, end: preserved.end }, { page: 3, end: 120 });
  assert.deepEqual({ page: clamped.page, end: clamped.end }, { page: 2, end: 80 });
  assert.deepEqual({ page: empty.page, start: empty.start, end: empty.end }, { page: 1, start: 0, end: 0 });
});
