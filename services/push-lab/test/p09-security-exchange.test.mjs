import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, onboard } from './helpers.mjs';
import { createPushLabServer } from '../server/http.mjs';

test('P-09 invite exchange is CAS/idempotent, self-test is bounded, and probes never enqueue', () => {
  const h = harness();
  try {
    h.service.createFixture({ userId: 'user-1', deliveryId: 'delivery-1', inviteCode: 'invite-1' });
    const first = h.service.exchangeInvite({ inviteCode: 'invite-1', exchangeKey: 'same-key' });
    const retry = h.service.exchangeInvite({ inviteCode: 'invite-1', exchangeKey: 'same-key' });
    assert.deepEqual(retry, first);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 1);
    assert.throws(() => h.service.exchangeInvite({ inviteCode: 'invite-1', exchangeKey: 'other-key' }), { code: 'invite_already_consumed' });
    h.service.createFixture({ userId: 'other-user', deliveryId: 'other-delivery', inviteCode: 'other-invite' });
    assert.throws(() => h.service.getDelivery(first.sessionToken, 'other-delivery'), { code: 'delivery_not_found' });

    const registration = h.service.registerInstallation(first.sessionToken, first.csrfToken, null, {
      fid: 'fid-1', provider: 'fcm', projectId: 'test', bootstrapKey: 'security-bootstrap-0123456789',
    });
    h.service.subscribe(first.sessionToken, first.csrfToken, registration.proofToken, 'delivery-1');
    for (let index = 0; index < 3; index += 1) {
      h.service.enqueueSelfTest(first.sessionToken, first.csrfToken, registration.proofToken, 'delivery-1', `rate-${index}`);
    }
    assert.throws(
      () => h.service.enqueueSelfTest(first.sessionToken, first.csrfToken, registration.proofToken, 'delivery-1', 'rate-3'),
      { code: 'self_test_rate_limited' },
    );
    assert.equal(h.service.enqueueSelfTest(first.sessionToken, first.csrfToken, registration.proofToken, 'delivery-1', 'rate-0').outboxId,
      h.db.prepare("SELECT o.id FROM outbox o JOIN self_test_requests r ON r.event_id=o.event_id WHERE r.idempotency_key='rate-0'").get().id);

    const probe = h.service.createDeploymentProbe({ userId: 'probe', inviteCode: 'probe-invite', deliverable: true });
    assert.match(probe.deliveryId, /^deployment_probe:/);
    assert.equal(probe.scope, 'deployment_probe');
    assert.equal(probe.deliverable, false);
    assert.deepEqual(h.db.prepare('SELECT scope,deliverable FROM deliveries WHERE id=?').get(probe.deliveryId), Object.assign(Object.create(null), { scope: 'deployment_probe', deliverable: 0 }));
    assert.deepEqual(h.service.emitEvent({ eventId: 'probe-event', deliveryId: probe.deliveryId, revision: 1, notificationType: 'probe', expiresAt: h.clock() + 60_000 }), { enqueued: 0 });
    assert.equal(h.db.prepare("SELECT count(*) AS count FROM outbox WHERE event_id='probe-event'").get().count, 0);
    assert.deepEqual(h.service.cleanupDeploymentProbe(probe.deliveryId), { deliveryId: probe.deliveryId, removed: true });
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM deliveries WHERE id=?').get(probe.deliveryId).count, 0);
  } finally { h.close(); }
});

test('P-09 HTTP boundary enforces exact Origin and restores CSRF only for a valid session cookie', async () => {
  const h = harness();
  const origin = 'https://push.test';
  const server = createPushLabServer({ db: h.db, service: h.service, origin });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    h.service.createFixture({ userId: 'user-1', deliveryId: 'delivery-1', inviteCode: 'invite-1' });
    const badOrigin = await fetch(`${base}/push-lab/api/session/exchange`, {
      method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'invite-1', exchangeKey: 'exchange-1' }),
    });
    assert.equal(badOrigin.status, 403);

    const exchange = await fetch(`${base}/push-lab/api/session/exchange`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'invite-1', exchangeKey: 'exchange-1' }),
    });
    assert.equal(exchange.status, 200);
    const setCookie = exchange.headers.get('set-cookie');
    assert.match(setCookie, /Path=\/push-lab\/;/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(';')[0];
    const restored = await fetch(`${base}/push-lab/api/session`, { headers: { cookie } });
    assert.equal(restored.status, 200);
    const restoredSession = await restored.json();
    assert.deepEqual(restoredSession.deliveryIds, ['delivery-1']);

    const missingRegistrationCsrf = await fetch(`${base}/push-lab/api/registration`, {
      method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ fid: 'fid-1', provider: 'fcm', projectId: 'test', bootstrapKey: 'http-bootstrap-0123456789' }),
    });
    assert.equal(missingRegistrationCsrf.status, 403);

    const invalidCsrf = await fetch(`${base}/push-lab/api/registration`, {
      method: 'PUT', headers: { origin, cookie, 'x-csrf-token': 'invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ fid: 'fid-1', provider: 'fcm', projectId: 'test', bootstrapKey: 'http-bootstrap-0123456789' }),
    });
    assert.equal(invalidCsrf.status, 403);

    const registration = await fetch(`${base}/push-lab/api/registration`, {
      method: 'PUT', headers: { origin, cookie, 'x-csrf-token': restoredSession.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ fid: 'fid-1', provider: 'fcm', projectId: 'test', bootstrapKey: 'http-bootstrap-0123456789' }),
    });
    assert.equal(registration.status, 200);
    const installationCookie = registration.headers.get('set-cookie').split(';')[0];
    const authenticatedCookies = `${cookie}; ${installationCookie}`;
    const missingCsrfRequests = [
      fetch(`${base}/push-lab/api/deliveries/delivery-1/subscription`, {
        method: 'PUT', headers: { origin, cookie: authenticatedCookies, 'content-type': 'application/json' }, body: JSON.stringify({ consentVersion: 'pilot-v1' }),
      }),
      fetch(`${base}/push-lab/api/deliveries/delivery-1/subscription`, {
        method: 'DELETE', headers: { origin, cookie: authenticatedCookies },
      }),
      fetch(`${base}/push-lab/api/deliveries/delivery-1/self-test`, {
        method: 'POST', headers: { origin, cookie: authenticatedCookies, 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'missing-csrf' }),
      }),
    ];
    assert.deepEqual(await Promise.all(missingCsrfRequests.map(async (request) => (await request).status)), [403, 403, 403]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    h.close();
  }
});

test('serves the PWA and service worker with safe no-cache headers', async () => {
  const h = harness();
  const server = createPushLabServer({ db: h.db, service: h.service, origin: 'https://push.test' });
  assert.ok(server.requestTimeout < 30_000);
  assert.ok(server.headersTimeout < 30_000);
  assert.ok(server.keepAliveTimeout < 30_000);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousKeys = process.env.EXCHANGE_KEYS;
  try {
    process.env.NODE_ENV = 'production';
    process.env.EXCHANGE_KEYS = 'replace-with-openssl-rand-base64-32';
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    process.env.EXCHANGE_KEYS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=!';
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    process.env.EXCHANGE_KEYS = `${Buffer.alloc(32).toString('base64')},${Buffer.alloc(32, 1).toString('base64')}`;
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    if (previousNodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousKeys == null) delete process.env.EXCHANGE_KEYS; else process.env.EXCHANGE_KEYS = previousKeys;
    h.db.exec('PRAGMA query_only=ON');
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    h.db.exec('PRAGMA query_only=OFF');
    for (const [path, type] of [['/push-lab/', 'text/html'], ['/push-lab/sw.js', 'text/javascript']]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(type));
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    }
    assert.equal((await fetch(`${base}/push-lab/%2e%2e/package.json`)).status, 404);
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousKeys == null) delete process.env.EXCHANGE_KEYS; else process.env.EXCHANGE_KEYS = previousKeys;
    await new Promise((resolve) => server.close(resolve));
    h.close();
  }
});
