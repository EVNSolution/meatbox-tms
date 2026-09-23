import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, onboard } from './helpers.mjs';
import { acquireWorkerLock } from '../worker/lock.mjs';
import { WorkerStore } from '../worker/store.mjs';

test('graceful release permits immediate restart while a live lease cannot be stolen', () => {
  const h = harness();
  try {
    const store = new WorkerStore(h.db, { now: h.clock });
    const first = store.acquire('worker-1');
    assert.ok(first);
    assert.equal(store.acquire('worker-2'), null);
    assert.equal(store.release(first), true);
    assert.ok(store.acquire('worker-2'));
  } finally { h.close(); }
});

test('OS worker lock excludes a second holder and is reusable after release', async () => {
  const h = harness();
  try {
    const first = await acquireWorkerLock(h.path);
    await assert.rejects(acquireWorkerLock(h.path), /another push-lab worker/);
    await first.release();
    const second = await acquireWorkerLock(h.path);
    await second.release();
  } finally { h.close(); }
});

test('an expired lease cannot be resurrected and can be acquired by a new owner', () => {
  const h = harness();
  try {
    const store = new WorkerStore(h.db, { now: h.clock, leaseMs: 1_000 });
    const first = store.acquire('worker-1');
    h.advance(1_001);
    assert.equal(store.heartbeat(first), false);
    assert.ok(store.acquire('worker-2'));
  } finally { h.close(); }
});

test('expired sending work is quarantined as unknown and is never automatically resent', () => {
  const h = harness();
  try {
    const user = onboard(h);
    const store = new WorkerStore(h.db, { now: h.clock, leaseMs: 1_000 });
    const first = store.acquire('worker-1');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'lost-response');
    const sending = store.claim(first);
    assert.ok(sending);
    h.advance(1_001);
    const second = store.acquire('worker-2');
    assert.ok(second);
    assert.equal(store.claim(second), null);
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(sending.id).status, 'unknown');
    h.advance(60_000);
    store.heartbeat(second);
    assert.equal(store.claim(second), null);
  } finally { h.close(); }
});
