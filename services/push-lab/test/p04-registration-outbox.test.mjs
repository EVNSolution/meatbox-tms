import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, onboard } from './helpers.mjs';

test('configured Firebase project rejects mismatched registration before changing installations', () => {
  const h = harness(undefined, { firebaseProjectId: 'approved-project' });
  try {
    h.service.createFixture({ userId: 'user-1', deliveryId: 'delivery-1', inviteCode: 'invite-1' });
    const session = h.service.exchangeInvite({ inviteCode: 'invite-1', exchangeKey: 'exchange-1' });
    const input = { fid: 'fid-1', provider: 'fcm', bootstrapKey: 'bootstrap-key-0123456789' };
    assert.throws(() => h.service.registerInstallation(session.sessionToken, session.csrfToken, null,
      { ...input, projectId: 'foreign-project' }), { code: 'firebase_project_mismatch' });
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM installations').get().count, 0);
    const registered = h.service.registerInstallation(session.sessionToken, session.csrfToken, null,
      { ...input, projectId: 'approved-project' });
    assert.throws(() => h.service.registerInstallation(session.sessionToken, session.csrfToken, registered.proofToken,
      { ...input, fid: 'fid-2', projectId: 'foreign-project', expectedFidVersion: 1 }), { code: 'firebase_project_mismatch' });
    assert.deepEqual(h.db.prepare('SELECT project_id, fcm_fid, fid_version FROM installations').get(),
      Object.assign(Object.create(null), { project_id: 'approved-project', fcm_fid: 'fid-1', fid_version: 1 }));
  } finally { h.close(); }
});

test('P-04 deduplicates events, preserves multi-order consent, and atomically replaces the FID', () => {
    const h = harness();
  try {
    const first = onboard(h);
    const recovered = h.service.registerInstallation(first.sessionToken, first.csrfToken, null, {
      fid: 'fid-1', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 0, bootstrapKey: first.bootstrapKey,
    });
    assert.equal(recovered.installationId, first.installationId);
    assert.equal(recovered.proofToken, first.proofToken);
    const afterCookieLoss = h.service.registerInstallation(first.sessionToken, first.csrfToken, null, {
      fid: 'fid-1', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 0, bootstrapKey: 'cookie-loss-new-bootstrap-0123456789',
    });
    assert.notEqual(afterCookieLoss.installationId, first.installationId);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM installations').get().count, 2);
    assert.equal(h.service.getDelivery(first.sessionToken, first.deliveryId, afterCookieLoss.proofToken).subscription, null);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM subscriptions').get().count, 1);
    const second = onboard(h, {
      deliveryId: 'delivery-2',
      inviteCode: 'invite-2',
      session: first,
      proof: first.proofToken,
      fid: 'fid-1',
    });
    assert.equal(second.csrfToken, first.csrfToken);
    const retriedFirstInvite = h.service.exchangeInvite({ inviteCode: 'invite-delivery-1', exchangeKey: 'exchange-delivery-1' });
    assert.equal(retriedFirstInvite.sessionToken, first.sessionToken);
    assert.equal(retriedFirstInvite.csrfToken, first.csrfToken);
    assert.deepEqual(retriedFirstInvite.deliveryIds, ['delivery-1', 'delivery-2']);
    const event = { eventId: 'event-1', deliveryId: first.deliveryId, revision: 1, notificationType: 'delivery_update', expiresAt: h.clock() + 60_000 };
    assert.equal(h.service.emitEvent(event).enqueued, 1);
    assert.equal(h.service.emitEvent(event).enqueued, 0);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM outbox').get().count, 1);
    assert.throws(() => h.service.emitEvent({ ...event, deliveryId: second.deliveryId }), { code: 'event_id_conflict' });
    assert.equal(h.db.prepare("SELECT count(*) AS count FROM outbox o JOIN subscriptions s ON s.id=o.subscription_id WHERE o.event_id='event-1' AND s.delivery_id='delivery-2'").get().count, 0);

    const firstSelfTest = h.service.enqueueSelfTest(second.sessionToken, second.csrfToken, first.proofToken, first.deliveryId, 'same-key');
    const secondSelfTest = h.service.enqueueSelfTest(second.sessionToken, second.csrfToken, first.proofToken, second.deliveryId, 'same-key');
    assert.notEqual(firstSelfTest.outboxId, secondSelfTest.outboxId);

    const updated = h.service.registerInstallation(second.sessionToken, second.csrfToken, first.proofToken, {
      fid: 'fid-2', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 1,
    });
    assert.equal(updated.installationId, first.installationId);
    assert.equal(updated.fidVersion, 2);
    const storedRegistration = h.db.prepare('SELECT fcm_fid,fid_version FROM installations').get();
    assert.equal(storedRegistration.fcm_fid, 'fid-2');
    assert.equal(storedRegistration.fid_version, 2);
    assert.throws(() => h.service.registerInstallation(second.sessionToken, second.csrfToken, first.proofToken, {
      fid: 'fid-stale', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 1,
    }), { code: 'fid_version_conflict' });
    const idempotent = h.service.registerInstallation(second.sessionToken, second.csrfToken, first.proofToken, {
      fid: 'fid-2', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 1,
    });
    assert.equal(idempotent.fidVersion, 2);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).registration.fidVersion, 2);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.fidVersion, 2);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NULL').get().count, 2);

    h.db.prepare('UPDATE installations SET active=0 WHERE id=?').run(first.installationId);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.active, false);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.consentActive, true);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.providerActive, false);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.status, 'active');
    assert.throws(() => h.service.subscribe(second.sessionToken, second.csrfToken, first.proofToken, second.deliveryId), { code: 'installation_inactive' });
    assert.deepEqual(h.service.unsubscribe(second.sessionToken, second.csrfToken, first.proofToken, second.deliveryId), {
      active: false, boundary: 'sending_or_unknown_may_arrive',
    });
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.consentActive, false);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription.status, 'revoked');
    h.service.registerInstallation(second.sessionToken, second.csrfToken, first.proofToken, { fid: 'fid-2', provider: 'fcm', projectId: 'test-project' });
    h.service.subscribe(second.sessionToken, second.csrfToken, first.proofToken, second.deliveryId);
    h.db.prepare('UPDATE subscriptions SET expires_at=? WHERE delivery_id=?').run(h.clock() - 1, second.deliveryId);
    const expired = h.service.getDelivery(second.sessionToken, second.deliveryId, first.proofToken).subscription;
    assert.equal(expired.status, 'expired');
    assert.equal(expired.expired, true);
    assert.equal(expired.consentActive, false);
    h.service.subscribe(second.sessionToken, second.csrfToken, first.proofToken, second.deliveryId);

    h.service.unsubscribe(second.sessionToken, second.csrfToken, first.proofToken, first.deliveryId);
    assert.equal(h.db.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM subscriptions WHERE delivery_id=?').get(first.deliveryId).revoked, 1);
    assert.equal(h.db.prepare('SELECT revoked_at FROM subscriptions WHERE delivery_id=?').get(second.deliveryId).revoked_at, null);
    assert.equal(h.service.getDelivery(second.sessionToken, first.deliveryId).delivery.id, first.deliveryId);
    assert.equal(h.service.getDelivery(second.sessionToken, second.deliveryId).delivery.id, second.deliveryId);
  } finally { h.close(); }
});

test('installation proof recovery is limited to two minutes', () => {
  const h = harness();
  try {
    const user = onboard(h);
    h.advance(120_001);
    assert.throws(() => h.service.registerInstallation(user.sessionToken, user.csrfToken, null, {
      fid: 'fid-1', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 0, bootstrapKey: user.bootstrapKey,
    }), { code: 'bootstrap_retry_expired' });
  } finally { h.close(); }
});

test('an event replay never enrolls subscriptions that joined after the original event', () => {
  const h = harness();
  try {
    h.service.createFixture({ userId: 'late-user', deliveryId: 'late-delivery', inviteCode: 'late-invite' });
    const event = {
      eventId: 'event-before-subscription',
      deliveryId: 'late-delivery',
      revision: 1,
      notificationType: 'delivery_update',
      expiresAt: h.clock() + 60_000,
    };
    assert.equal(h.service.emitEvent(event).enqueued, 0);
    const session = h.service.exchangeInvite({ inviteCode: 'late-invite', exchangeKey: 'late-exchange' });
    const registration = h.service.registerInstallation(session.sessionToken, session.csrfToken, null, {
      fid: 'late-fid',
      provider: 'fcm',
      projectId: 'test-project',
      bootstrapKey: 'late-bootstrap-0123456789',
    });
    h.service.subscribe(session.sessionToken, session.csrfToken, registration.proofToken, 'late-delivery');
    assert.equal(h.service.emitEvent(event).enqueued, 0);
    assert.equal(h.db.prepare("SELECT count(*) AS count FROM outbox WHERE event_id='event-before-subscription'").get().count, 0);
  } finally { h.close(); }
});
