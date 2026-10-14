import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDeliveryOrderPositions,
  moveDeliveryOrderPosition,
  resolveDeliveryOrderDragTarget,
} from './sortableOrder';

describe('sortable delivery order positions', () => {
  it('creates one stable visual slot for every seller order', () => {
    assert.deepEqual(createDeliveryOrderPositions(['a', 'b', 'c']), {
      a: 0,
      b: 1,
      c: 2,
    });
  });

  it('shifts every crossed order when a drag skips multiple slots', () => {
    const moved = moveDeliveryOrderPosition(
      { a: 0, b: 1, c: 2, d: 3 },
      'a',
      3,
    );

    assert.deepEqual(moved, { a: 3, b: 0, c: 1, d: 2 });
  });

  it('keeps the current slot inside the hysteresis deadband', () => {
    const rowStep = 100;

    assert.equal(
      resolveDeliveryOrderDragTarget({
        absoluteTop: 57,
        currentIndex: 0,
        rowCount: 4,
        rowStep,
      }),
      0,
    );
    assert.equal(
      resolveDeliveryOrderDragTarget({
        absoluteTop: 59,
        currentIndex: 0,
        rowCount: 4,
        rowStep,
      }),
      1,
    );
    assert.equal(
      resolveDeliveryOrderDragTarget({
        absoluteTop: 43,
        currentIndex: 1,
        rowCount: 4,
        rowStep,
      }),
      1,
    );
    assert.equal(
      resolveDeliveryOrderDragTarget({
        absoluteTop: 41,
        currentIndex: 1,
        rowCount: 4,
        rowStep,
      }),
      0,
    );
  });

  it('resolves a fast drag across several slots in one update', () => {
    assert.equal(
      resolveDeliveryOrderDragTarget({
        absoluteTop: 265,
        currentIndex: 0,
        rowCount: 5,
        rowStep: 100,
      }),
      3,
    );
  });
});
