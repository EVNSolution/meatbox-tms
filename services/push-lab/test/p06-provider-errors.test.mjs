import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, onboard } from './helpers.mjs';
import { buildFcmMessage, classifyProviderError, retryAfterMs, sendWithTimeout } from '../worker/sender.mjs';
import { WorkerStore } from '../worker/store.mjs';

test('P-06 classifies provider failures and caps retries', () => {
  assert.equal(classifyProviderError(Object.assign(new Error(), { status: 429 })), 'rate_limited');
  assert.equal(classifyProviderError(Object.assign(new Error(), { status: 503 })), 'transient');
  assert.equal(classifyProviderError(Object.assign(new Error(), { name: 'AbortError' })), 'unknown');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-timeout' })), 'unknown');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-error', cause: { code: 'ETIMEDOUT' } })), 'unknown');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-error', cause: { code: 'ECONNRESET' } })), 'unknown');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-error', cause: { code: 'ENOTFOUND' } })), 'transient');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-error', cause: { code: 'EAI_AGAIN' } })), 'transient');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'app/network-error', cause: { code: 'ECONNREFUSED' } })), 'transient');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/registration-token-not-registered' })), 'invalid_registration');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/installation-id-not-registered' })), 'invalid_registration');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/invalid-registration-token' })), 'invalid_registration');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/message-rate-exceeded' })), 'rate_limited');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/device-message-rate-exceeded' })), 'rate_limited');
  assert.equal(classifyProviderError(Object.assign(new Error(), { httpResponse: { status: 429, headers: {} } })), 'rate_limited');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'messaging/mismatched-credential' })), 'configuration');
  assert.equal(classifyProviderError(Object.assign(new Error(), { code: 'push-lab/fid-not-allowed' })), 'permanent');
  assert.equal(retryAfterMs({ httpResponse: { status: 429, headers: { 'retry-after': '12' } } }, 0), 12_000);
  assert.equal(retryAfterMs({ httpResponse: { status: 429, headers: { 'Retry-After': new Date(120_000).toUTCString() } } }, 0), 120_000);
  const message = buildFcmMessage({ fid: 'fid-1', deliveryId: 'delivery-1', notificationId: 'notification-1', ttlSeconds: 30 });
  assert.equal(message.fid, 'fid-1');
  assert.equal('notification' in message, false);
  assert.deepEqual(message.data, {
    deliveryId: 'delivery-1', title: '[테스트] 미트박스 배송 알림', body: '테스트 배송 상태를 확인해 주세요.', notificationId: 'notification-1',
  });

  const h = harness();
  try {
    const user = onboard(h);
    const store = new WorkerStore(h.db, { now: h.clock, maxAttempts: 3, random: () => 0.5 });
    let lease = store.acquire('worker-1');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'retry-limit');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const item = store.claim(lease);
      assert.ok(item);
      store.finish(item, { errorClass: 'transient' });
      const status = h.db.prepare('SELECT status FROM outbox WHERE id=?').get(item.id).status;
      assert.equal(status, attempt < 3 ? 'retrying' : 'failed');
      h.advance(10_000);
      store.heartbeat(lease);
    }
    assert.equal(store.claim(lease), null);

    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'timeout');
    const unknown = store.claim(lease);
    store.finish(unknown, { errorClass: 'unknown' });
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(unknown.id).status, 'unknown');

    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'retry-after');
    const limited = store.claim(lease);
    store.finish(limited, { errorClass: 'rate_limited', retryAfterMs: 45_000 });
    assert.equal(h.db.prepare('SELECT retry_at FROM outbox WHERE id=?').get(limited.id).retry_at, h.clock() + 45_000);
    h.db.prepare("UPDATE outbox SET status='failed',retry_at=NULL WHERE id=?").run(limited.id);

    h.advance(600_001);
    lease = store.acquire('worker-2');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'retry-after-over-backoff-cap');
    const longLimited = store.claim(lease);
    store.finish(longLimited, { errorClass: 'rate_limited', retryAfterMs: 120_000 });
    assert.equal(h.db.prepare('SELECT retry_at FROM outbox WHERE id=?').get(longLimited.id).retry_at, h.clock() + 120_000);
    h.db.prepare("UPDATE outbox SET status='failed',retry_at=NULL WHERE id=?").run(longLimited.id);

    h.advance(600_001);
    lease = store.acquire('worker-3');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'retry-after-past-ttl');
    const pastTtl = store.claim(lease);
    h.db.prepare('UPDATE outbox SET expires_at=? WHERE id=?').run(h.clock() + 30_000, pastTtl.id);
    store.finish(pastTtl, { errorClass: 'rate_limited', retryAfterMs: 120_000 });
    assert.deepEqual(
      { ...h.db.prepare('SELECT status,retry_at FROM outbox WHERE id=?').get(pastTtl.id) },
      { status: 'expired', retry_at: null },
    );
  } finally { h.close(); }
});

test('provider calls have a finite timeout classified as unknown', async () => {
  let settle;
  let timeoutError;
  await assert.rejects(
    sendWithTimeout({ send: () => new Promise((resolve) => { settle = resolve; }) }, {}, 10),
    (error) => {
      timeoutError = error;
      return classifyProviderError(error) === 'unknown';
    },
  );
  assert.ok(timeoutError.settlement instanceof Promise);
  settle('provider/late');
  await timeoutError.settlement;
});

test('late invalid response for an old FID leaves its replacement active and consent intact', () => {
  const h = harness();
  try {
    const user = onboard(h);
    const store = new WorkerStore(h.db, { now: h.clock });
    const lease = store.acquire('worker-1');
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'old-fid');
    const oldClaim = store.claim(lease);
    assert.equal(oldClaim.selected_fid, 'fid-1');
    assert.equal(oldClaim.selected_fid_version, 1);
    const replacement = h.service.registerInstallation(user.sessionToken, user.csrfToken, user.proofToken, {
      fid: 'fid-2', provider: 'fcm', projectId: 'test-project', expectedFidVersion: 1,
    });
    assert.equal(replacement.fidVersion, 2);

    assert.equal(store.finish(oldClaim, { errorClass: 'invalid_registration' }), true);
    assert.deepEqual({ ...h.db.prepare('SELECT fcm_fid,fid_version,active FROM installations WHERE id=?').get(user.installationId) },
      { fcm_fid: 'fid-2', fid_version: 2, active: 1 });
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(oldClaim.id).status, 'failed');
    assert.deepEqual({ ...h.db.prepare('SELECT consent_version,revoked_at FROM subscriptions WHERE id=?').get(oldClaim.subscription_id) },
      { consent_version: 'pilot-v1', revoked_at: null });
  } finally { h.close(); }
});

test('current FID invalid response deactivates only the installation and preserves revoked or expired consent', () => {
  for (const state of ['current', 'revoked', 'expired']) {
    const h = harness();
    try {
      const user = onboard(h);
      const store = new WorkerStore(h.db, { now: h.clock });
      const lease = store.acquire('worker-1');
      h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, state);
      const claim = store.claim(lease);
      if (state === 'revoked') h.service.unsubscribe(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId);
      if (state === 'expired') h.db.prepare('UPDATE subscriptions SET expires_at=? WHERE id=?').run(h.clock() - 1, claim.subscription_id);
      const consent = { ...h.db.prepare('SELECT consent_version,revoked_at,expires_at FROM subscriptions WHERE id=?').get(claim.subscription_id) };

      assert.equal(store.finish(claim, { errorClass: 'invalid_registration' }), true);
      assert.equal(h.db.prepare('SELECT active FROM installations WHERE id=?').get(user.installationId).active, 0);
      assert.deepEqual({ ...h.db.prepare('SELECT consent_version,revoked_at,expires_at FROM subscriptions WHERE id=?').get(claim.subscription_id) }, consent);
      assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(claim.id).status,
        state === 'current' ? 'failed' : 'cancelled');
    } finally { h.close(); }
  }
});
