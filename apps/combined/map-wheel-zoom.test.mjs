import test from 'node:test';
import assert from 'node:assert/strict';
import { modifierWheelZoomAllowed, modifierWheelZoomMessage } from './map-wheel-zoom.mjs';

test('Control과 Command 휠만 지도 확대 입력으로 허용한다', () => {
  assert.equal(modifierWheelZoomAllowed({ ctrlKey: true, metaKey: false }), true);
  assert.equal(modifierWheelZoomAllowed({ ctrlKey: false, metaKey: true }), true);
  assert.equal(modifierWheelZoomAllowed({ ctrlKey: true, metaKey: true }), true);
  assert.equal(modifierWheelZoomAllowed({ ctrlKey: false, metaKey: false }), false);
  assert.match(modifierWheelZoomMessage, /Control.*Command/);
});
