import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toAppLocation, withTimeout } from './location';

test('a reading becomes an event location; broken readings are dropped', () => {
  assert.deepEqual(toAppLocation({ latitude: 37.5, longitude: 127, accuracy: 8.4 }), { lat: 37.5, lng: 127, accuracyM: 8 });
  assert.deepEqual(toAppLocation({ latitude: 37.5, longitude: 127, accuracy: null }), { lat: 37.5, lng: 127 });
  assert.equal(toAppLocation({ latitude: 91, longitude: 127 }), null);
  assert.equal(toAppLocation({ latitude: 37.5, longitude: Number.NaN }), null);
});

test('a slow reading times out and a fast one passes', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 50), 1);
  await assert.rejects(withTimeout(new Promise(() => undefined), 10), /timeout/u);
});
