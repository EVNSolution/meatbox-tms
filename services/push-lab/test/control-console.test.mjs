import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createPushLabServer } from '../server/http.mjs';
import { AdminAuth } from '../server/admin-auth.mjs';
import { harness } from './helpers.mjs';
import { WorkerStore } from '../worker/store.mjs';
import { MockSender } from '../worker/sender.mjs';

const ORIGIN = 'https://push-lab.example.test';

async function serverFor(h, hashFile) {
  const server = createPushLabServer({ db: h.db, service: h.service, origin: ORIGIN,
    adminAuth: new AdminAuth(h.db, { now: h.clock, hashFile }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}/push-lab/control/api` };
}

async function call(base, path, { method = 'GET', cookie = '', csrf = '', input, origin = ORIGIN } = {}) {
  const headers = { cookie };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (method !== 'GET') { headers.Origin = origin; headers['Content-Type'] = 'application/json'; }
  const response = await fetch(`${base}${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
  return { status: response.status, data: await response.json(), setCookie: response.headers.getSetCookie() };
}

test('admin HTTP fails closed and requires independent session, origin, and CSRF', async () => {
  const h = harness();
  const hashFile = join(dirname(h.path), 'admin.hash');
  const password = 'test-password-12345';
  const salt = randomBytes(16);
  writeFileSync(hashFile, `${salt.toString('hex')}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}\n`, { mode: 0o600 });
  const { server, base } = await serverFor(h, undefined);
  try {
    assert.equal((await call(base, '/login-challenge')).status, 503);
    assert.equal((await call(base, '/deliveries', { cookie: 'mb_push_session=customer' })).status, 503);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const live = await serverFor(h, hashFile);
  try {
    for (const file of ['app.mjs', 'model.mjs']) {
      const staticResponse = await fetch(live.base.replace(/\/api$/, `/${file}`));
      assert.equal(staticResponse.status, 200);
      assert.match(staticResponse.headers.get('content-type'), /text\/javascript/);
    }
    assert.equal((await fetch(live.base.replace(/\/api$/, '/model.test.mjs'))).status, 404);
    assert.equal((await call(live.base, '/deliveries', { cookie: 'mb_push_session=customer' })).status, 401);
    const challenge = await call(live.base, '/login-challenge');
    assert.equal(challenge.status, 200);
    const loginCookie = challenge.setCookie[0].split(';')[0];
    assert.equal((await call(live.base, '/login', { method: 'POST', cookie: loginCookie, csrf: challenge.data.csrfToken, input: { password }, origin: 'https://wrong.test' })).status, 403);
    assert.equal((await call(live.base, '/login', { method: 'POST', cookie: loginCookie, csrf: 'wrong', input: { password } })).status, 403);
    assert.equal((await call(live.base, '/login', { method: 'POST', cookie: loginCookie, csrf: challenge.data.csrfToken, input: { password: 'wrong' } })).status, 401);
    const fresh = await call(live.base, '/login-challenge');
    const login = await call(live.base, '/login', { method: 'POST', cookie: fresh.setCookie[0].split(';')[0], csrf: fresh.data.csrfToken, input: { password } });
    assert.equal(login.status, 200);
    assert.match(login.setCookie[0], /Secure; HttpOnly; SameSite=Strict/);
    const adminCookie = login.setCookie[0].split(';')[0];
    const session = await call(live.base, '/session', { cookie: adminCookie });
    assert.equal(session.data.csrfToken, login.data.csrfToken);
    assert.equal(session.data.senderMode, 'mock');
    assert.equal((await call(live.base, '/deliveries', { cookie: adminCookie })).status, 200);
    assert.equal((await call(live.base, '/deliveries', { method: 'POST', cookie: adminCookie, csrf: 'wrong', input: { userId: 'test-a' } })).status, 403);
    assert.equal((await call(live.base, '/deliveries', { method: 'POST', cookie: adminCookie, csrf: login.data.csrfToken, origin: 'https://wrong.test', input: { userId: 'test-a' } })).status, 403);
    assert.equal((await call(live.base, '/logout', { method: 'POST', cookie: adminCookie, csrf: login.data.csrfToken, input: {} })).status, 200);
    assert.equal((await call(live.base, '/session', { cookie: adminCookie })).status, 401);
  } finally { await new Promise((resolve) => live.server.close(resolve)); h.close(); }
});

test('admin failures are limited by socket source and sessions expire after eight hours', () => {
  const h = harness();
  try {
    const hashFile = join(dirname(h.path), 'admin.hash');
    const salt = randomBytes(16);
    writeFileSync(hashFile, `${salt.toString('hex')}:${scryptSync('test-password-12345', salt, 64).toString('hex')}\n`, { mode: 0o600 });
    const auth = new AdminAuth(h.db, { now: h.clock, hashFile });
    for (let i = 0; i < 5; i++) {
      const challenge = auth.challenge();
      assert.throws(() => auth.login({ password: 'wrong', cookieToken: challenge.csrfToken, headerToken: challenge.csrfToken, source: '127.0.0.1' }), { status: 401 });
    }
    const blocked = auth.challenge();
    assert.throws(() => auth.login({ password: 'test-password-12345', cookieToken: blocked.csrfToken, headerToken: blocked.csrfToken, source: '127.0.0.1' }), { status: 429 });
    h.advance(15 * 60_000 + 1);
    const challenge = auth.challenge();
    const session = auth.login({ password: 'test-password-12345', cookieToken: challenge.csrfToken, headerToken: challenge.csrfToken, source: '127.0.0.1' });
    assert.equal(auth.session(session.sessionToken).csrfToken, session.csrfToken);
    h.advance(8 * 60 * 60_000);
    assert.throws(() => auth.session(session.sessionToken), { status: 401 });
  } finally { h.close(); }
});

test('TEST workflow reissues invite, advances one stage without fanout, and enqueues one selected subscription', async () => {
  const h = harness();
  try {
    const created = h.service.createAdminDelivery({ userId: 'test-customer-01' }, ORIGIN);
    const deliveryId = created.delivery.id;
    const original = new URL(created.invite.url).hash.split('=')[1];
    const replacement = h.service.reissueAdminInvitation(deliveryId, ORIGIN);
    assert.throws(() => h.service.exchangeInvite({ inviteCode: original, exchangeKey: 'first' }), { code: 'invalid_invite' });
    const inviteCode = new URL(replacement.invite.url).hash.split('=')[1];
    const customer = h.service.exchangeInvite({ inviteCode, exchangeKey: 'second' });
    assert.equal(h.service.getDelivery(customer.sessionToken, deliveryId).delivery.id, deliveryId);
    const registered = h.service.registerInstallation(customer.sessionToken, customer.csrfToken, null,
      { fid: 'test-fid', provider: 'fcm', projectId: 'test', bootstrapKey: 'test-bootstrap-0123456789' });
    h.service.subscribe(customer.sessionToken, customer.csrfToken, registered.proofToken, deliveryId);
    const other = h.service.registerInstallation(customer.sessionToken, customer.csrfToken, null,
      { fid: 'other-fid', provider: 'fcm', projectId: 'test', bootstrapKey: 'other-bootstrap-0123456789' });
    h.service.subscribe(customer.sessionToken, customer.csrfToken, other.proofToken, deliveryId);
    const before = h.service.getAdminDelivery(deliveryId);
    assert.equal(before.subscriptions.length, 2);
    assert.equal(JSON.stringify(before).includes('test-fid'), false);
    const stageEvent = randomUUID();
    const stageInput = { stage: '배송 중', expectedRevision: 1, eventId: stageEvent };
    assert.deepEqual(h.service.advanceAdminStage(deliveryId, stageInput), { delivery: { id: deliveryId, stage: '배송 중', revision: 2 }, enqueued: 0 });
    assert.equal(h.service.getAdminDelivery(deliveryId).outbox.length, 0);
    assert.equal(h.service.advanceAdminStage(deliveryId, stageInput).enqueued, 0);
    assert.throws(() => h.service.advanceAdminStage(deliveryId, { ...stageInput, stage: '근처 도착' }), { code: 'event_id_conflict' });
    assert.throws(() => h.service.advanceAdminStage(deliveryId, { stage: '배송 완료', expectedRevision: 2, eventId: randomUUID() }), { code: 'stage_order_conflict' });
    const subscriptionId = h.db.prepare('SELECT id FROM subscriptions WHERE delivery_id=? AND installation_id=?').get(deliveryId, other.installationId).id;
    const eventId = randomUUID();
    const send = h.service.enqueueAdminTest(deliveryId, { subscriptionId, eventId, expectedRevision: 2 });
    assert.equal(send.status, 'queued');
    assert.equal(h.service.enqueueAdminTest(deliveryId, { subscriptionId, eventId, expectedRevision: 2 }).outboxId, send.outboxId);
    assert.equal(h.service.getAdminDelivery(deliveryId).outbox.length, 1);
    assert.throws(() => h.service.enqueueAdminTest(deliveryId, { subscriptionId, eventId, expectedRevision: 1 }), { code: 'event_id_conflict' });
    h.service.unsubscribe(customer.sessionToken, customer.csrfToken, other.proofToken, deliveryId);
    assert.throws(() => h.service.enqueueAdminTest(deliveryId, { subscriptionId, eventId: randomUUID(), expectedRevision: 2 }), { code: 'subscription_not_found' });
    assert.equal(h.service.getAdminDelivery(deliveryId).outbox[0].status, 'cancelled');
    const remainingId = h.db.prepare('SELECT id FROM subscriptions WHERE delivery_id=? AND installation_id=?').get(deliveryId, registered.installationId).id;
    const accepted = h.service.enqueueAdminTest(deliveryId, { subscriptionId: remainingId, eventId: randomUUID(), expectedRevision: 2 });
    const store = new WorkerStore(h.db, { now: h.clock });
    const lease = store.acquire('test-worker');
    const item = store.claim(lease);
    assert.equal(item.id, accepted.outboxId);
    const sender = new MockSender();
    const messageId = await sender.send({ fid: item.selected_fid, deliveryId });
    assert.match(messageId, /^mock\//);
    store.finish(item, { messageId });
    assert.equal(h.service.getAdminDelivery(deliveryId).outbox.find((row) => row.id === accepted.outboxId).status, 'accepted');
  } finally { h.close(); }
});
