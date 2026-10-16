import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editBlock } from './routeEditing';

test('the order can be edited before and during the run, but not after it or with reports waiting on the phone', () => {
  assert.equal(editBlock('idle', 0), null);
  assert.equal(editBlock('preparing', 0), null);
  assert.equal(editBlock('delivering', 0), null);
  assert.match(editBlock('done', 0) ?? '', /끝난/u);
  assert.match(editBlock('delivering', 2) ?? '', /전송 대기/u);
});
