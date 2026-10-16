import assert from 'node:assert/strict';
import { test } from 'node:test';

import { telUrl } from './phone';

test('a phone number becomes a tel link without spaces or dashes; anything else is no link', () => {
  assert.equal(telUrl('02-1234-5678'), 'tel:0212345678');
  assert.equal(telUrl(' +82 2 1234 5678 '), 'tel:+82212345678');
  assert.equal(telUrl('1588-0000'), 'tel:15880000');
  assert.equal(telUrl(''), null);
  assert.equal(telUrl(undefined), null);
  assert.equal(telUrl('tel:112'), null);
  assert.equal(telUrl('010-1234-5678;rm'), null);
  assert.equal(telUrl('12'), null);
});
