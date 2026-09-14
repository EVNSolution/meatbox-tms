import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPosition } from './scenario-tools.mjs';

test('a moved or expanded floating panel remains reachable within desktop and narrow viewports', () => {
  assert.deepEqual(clampPosition(1100, 650, 1120, 260, 1280, 720), { x: 152, y: 452 });
  assert.deepEqual(clampPosition(152, 452, 1120, 650, 1280, 720), { x: 152, y: 62 });
  assert.deepEqual(clampPosition(500, 200, 400, 300, 1280, 720), { x: 500, y: 200 });
  assert.deepEqual(clampPosition(-50, -20, 400, 300, 1280, 720), { x: 8, y: 8 });
  assert.deepEqual(clampPosition(1100, 650, 400, 300, 1280, 720), { x: 872, y: 412 });
  assert.deepEqual(clampPosition(872, 412, 374, 300, 390, 600), { x: 8, y: 292 });
});
