import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canAddPhoto, DEFAULT_PHOTOS, JPEG_QUALITY, MAX_LONG_SIDE_PX, MAX_PHOTO_BYTES, MAX_PHOTOS, missingPhotoMessage, planResize,
  REQUIRE_COMPLETION_PHOTO, RETRY_JPEG_QUALITY,
} from './photoPolicy';

test('the policy constants are the agreed ones', () => {
  assert.deepEqual([DEFAULT_PHOTOS, MAX_PHOTOS, MAX_LONG_SIDE_PX, JPEG_QUALITY, RETRY_JPEG_QUALITY], [1, 3, 1600, 0.8, 0.6]);
  assert.equal(MAX_PHOTO_BYTES, 5 * 1024 * 1024);
  assert.equal(REQUIRE_COMPLETION_PHOTO, true);
});

test('only the long side shrinks to 1600, the ratio is kept, and nothing is enlarged', () => {
  assert.deepEqual(planResize(4000, 3000), { width: 1600 });
  assert.deepEqual(planResize(3000, 4000), { height: 1600 });
  assert.deepEqual(planResize(3000, 3000), { width: 1600 });
  assert.equal(planResize(1600, 900), null);
  assert.equal(planResize(800, 600), null);
  assert.equal(planResize(0, 600), null);
  assert.equal(planResize(Number.NaN, 600), null);
});

test('up to three photos; a completion needs one, a failure or partial delivery does not', () => {
  assert.equal(canAddPhoto(2), true);
  assert.equal(canAddPhoto(3), false);
  assert.match(missingPhotoMessage('completed', 0) ?? '', /1장/u);
  assert.equal(missingPhotoMessage('completed', 1), null);
  assert.equal(missingPhotoMessage('failed', 0), null);
  assert.equal(missingPhotoMessage('partial', 0), null);
});
