import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSession } from '../api/contracts';
import { isDriverAccount } from './account';

test('only an account whose role is driver may use the app', () => {
  assert.equal(isDriverAccount(readSession({ user: { username: 'kim', role: 'driver' } })), true);
  assert.equal(isDriverAccount(readSession({ user: { username: 'boss', role: 'ops' } })), false);
});

test('a session without a role, or with one that is not text, is not a driver account', () => {
  assert.equal(readSession({ user: { username: 'old' } }).role, null);
  assert.equal(readSession({ user: { username: 'odd', role: 7 } }).role, null);
  assert.equal(isDriverAccount(readSession({ user: { username: 'old' } })), false);
});
