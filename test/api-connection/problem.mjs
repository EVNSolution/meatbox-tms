import assert from 'node:assert/strict';

// RFC 9457 error contract: `error` mirrors `code` for frontend compatibility.
export function assertProblem(response, body, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^application\/problem\+json/);
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assert.equal(body.error, code);
}
