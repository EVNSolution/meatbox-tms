import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RetryAttempt } from './retryAttempt';

test('the same request reuses its attempt until it settles; a different request starts a new one', async () => {
  let count = 0;
  const attempts = new RetryAttempt<string>();
  const create = () => `attempt-${++count}`;
  assert.equal(await attempts.get('departed', create), 'attempt-1');
  assert.equal(await attempts.get('departed', create), 'attempt-1');
  assert.equal(await attempts.get('reorder:a,b:7', create), 'attempt-2');
  assert.equal(await attempts.get('departed', create), 'attempt-3');
  attempts.settle();
  assert.equal(await attempts.get('departed', create), 'attempt-4');
});
