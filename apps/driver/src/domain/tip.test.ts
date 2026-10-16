import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tipProblem } from './tip';

test('a tip must be new, non-empty, at most 500 characters and plain text', () => {
  assert.equal(tipProblem('뒷문 이용', ''), null);
  assert.equal(tipProblem('  ', ''), '팁 내용을 입력해 주세요.');
  assert.match(tipProblem('가'.repeat(501), '') ?? '', /500자/u);
  assert.equal(tipProblem('가'.repeat(500), ''), null);
  assert.match(tipProblem('<b>', '') ?? '', /쓸 수 없는/u);
  assert.match(tipProblem('끊김\u0001', '') ?? '', /쓸 수 없는/u);
  assert.equal(tipProblem('줄\n바꿈\r\n가능', ''), null);
  assert.equal(tipProblem(' 같은 팁 ', '같은 팁'), '바뀐 내용이 없습니다.');
});
