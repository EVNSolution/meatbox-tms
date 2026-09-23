import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, onboard } from './helpers.mjs';
import { WorkerStore } from '../worker/store.mjs';

test('P-05 revocation prevents new claims/retries while an already sending attempt remains explicit', () => {
  const h = harness();
  try {
    const user = onboard(h);
    const store = new WorkerStore(h.db, { now: h.clock });
    const lease = store.acquire('worker-1');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'before-claim');
    h.service.unsubscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
    assert.equal(store.claim(lease), null);
    assert.equal(h.db.prepare('SELECT status FROM outbox').get().status, 'cancelled');

    h.service.subscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'after-claim');
    const item = store.claim(lease);
    assert.equal(item.status, 'queued');
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(item.id).status, 'sending');
    h.service.unsubscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
    assert.equal(store.finish(item, { errorClass: 'transient' }), true);
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(item.id).status, 'cancelled');
    assert.equal(store.claim(lease), null);

    h.service.subscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'unknown-after-revocation');
    const unknown = store.claim(lease);
    h.service.unsubscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
    assert.equal(store.finish(unknown, { errorClass: 'unknown' }), true);
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(unknown.id).status, 'unknown');
  } finally { h.close(); }
});

test('delivery completion changes stage/revision and cancels older queued work in one transaction', () => {
  const h = harness();
  try {
    const user = onboard(h);
    assert.equal(h.service.emitEvent({
      eventId: 'departure-event', deliveryId: user.deliveryId, revision: 1, notificationType: 'departure', expiresAt: h.clock() + 60_000,
    }).enqueued, 1);
    assert.equal(h.service.emitEvent({
      eventId: 'completed-event', deliveryId: user.deliveryId, revision: 2, stage: '배송 완료', notificationType: 'completed', expiresAt: h.clock() + 60_000,
    }).enqueued, 1);
    const delivery = h.db.prepare('SELECT stage,revision FROM deliveries WHERE id=?').get(user.deliveryId);
    assert.equal(delivery.stage, '배송 완료');
    assert.equal(delivery.revision, 2);
    assert.equal(h.db.prepare("SELECT status FROM outbox WHERE event_id='departure-event'").get().status, 'cancelled');
    assert.equal(h.db.prepare("SELECT status FROM outbox WHERE event_id='completed-event'").get().status, 'queued');
    assert.equal(h.service.emitEvent({
      eventId: 'completed-event', deliveryId: user.deliveryId, revision: 2, stage: '배송 완료', notificationType: 'completed', expiresAt: h.clock() + 60_000,
    }).enqueued, 0);
    assert.throws(() => h.service.emitEvent({
      eventId: 'completed-event', deliveryId: user.deliveryId, revision: 2, stage: '배송 중', notificationType: 'completed', expiresAt: h.clock() + 60_000,
    }), { code: 'event_id_conflict' });
  } finally { h.close(); }
});
