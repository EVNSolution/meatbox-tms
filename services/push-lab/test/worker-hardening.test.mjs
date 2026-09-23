import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, onboard } from './helpers.mjs';
import { createRealSender, createSender } from '../worker/sender.mjs';
import { startWorker } from '../worker/worker.mjs';

async function waitForStatus(db, expected) {
  for (let count = 0; count < 100; count += 1) {
    const row = db.prepare('SELECT status FROM outbox ORDER BY created_at DESC LIMIT 1').get();
    if (row?.status === expected) return;
    await delay(5);
  }
  assert.fail(`outbox did not reach ${expected}`);
}

async function waitForOutboxStatus(db, id, expected) {
  for (let count = 0; count < 100; count += 1) {
    if (db.prepare('SELECT status FROM outbox WHERE id=?').get(id)?.status === expected) return;
    await delay(5);
  }
  assert.fail(`outbox ${id} did not reach ${expected}`);
}

async function waitForFile(path) {
  for (let count = 0; count < 100; count += 1) {
    try {
      await access(path);
      return;
    } catch {
      await delay(5);
    }
  }
  assert.fail(`${path} was not created`);
}

test('shutdown stops claims and marks an undrained sending attempt unknown before DB close', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'drain-timeout');
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender: { send: () => new Promise(() => {}) },
      pollMs: 100_000,
      senderTimeoutMs: 100,
      drainMs: 10,
      now: h.clock,
    });
    await waitForStatus(h.db, 'sending');
    await worker.stop();
    const row = h.db.prepare('SELECT status,owner,lease_until FROM outbox').get();
    assert.equal(row.status, 'unknown');
    assert.equal(row.owner, null);
    assert.equal(row.lease_until, null);
    assert.equal(await worker.runOnce(), false);
    await delay(110);
  } finally { h.close(); }
});

test('configuration errors pause the worker and leave later work unclaimed', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'bad-config');
    const sender = { send: async () => { throw Object.assign(new Error('bad credentials'), { code: 'messaging/authentication-error' }); } };
    const logs = [];
    const logger = { error: (...args) => logs.push(args) };
    const marker = join(dirname(h.path), 'worker.pause');
    const worker = await startWorker({ db: h.db, dbPath: h.path, sender, pollMs: 100_000, now: h.clock, logger });
    await waitForStatus(h.db, 'failed');
    await waitForFile(marker);
    assert.equal(worker.paused, true);
    assert.equal(worker.pauseReason, 'bad credentials');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      code: 'messaging/authentication-error',
      timestamp: h.clock(),
    });
    assert.deepEqual(logs, [['push-lab worker paused', { code: 'messaging/authentication-error' }]]);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'paused-work');
    assert.equal(await worker.runOnce(), false);
    assert.equal(h.db.prepare("SELECT count(*) AS count FROM outbox WHERE status='queued'").get().count, 1);
    await worker.stop();
    await access(marker);
  } finally { h.close(); }
});

test('restart without operator acknowledgement preserves the marker and stays paused with no queue', async () => {
  const h = harness();
  try {
    const marker = join(dirname(h.path), 'worker.pause');
    const contents = `${JSON.stringify({ code: 'messaging/authentication-error', timestamp: h.clock() })}\n`;
    await writeFile(marker, contents, { mode: 0o600 });
    const logs = [];
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender: { send: async () => 'must-not-send' },
      pollMs: 100_000,
      now: h.clock,
      logger: { error: (...args) => logs.push(args) },
    });
    assert.equal(worker.paused, true);
    assert.equal(worker.pauseReason, 'messaging/authentication-error');
    assert.equal(await worker.runOnce(), false);
    assert.equal(await readFile(marker, 'utf8'), contents);
    assert.deepEqual(logs, [['push-lab worker remains paused', { code: 'messaging/authentication-error' }]]);
    await worker.stop();
    await access(marker);
  } finally { h.close(); }
});

test('explicit operator acknowledgement clears a persistent pause before resuming', async () => {
  const h = harness();
  try {
    const marker = join(dirname(h.path), 'worker.pause');
    await writeFile(marker, `${JSON.stringify({ code: 'messaging/authentication-error', timestamp: h.clock() })}\n`, { mode: 0o600 });
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender: { send: async () => 'mock/resumed' },
      pollMs: 100_000,
      now: h.clock,
      clearPause: true,
    });
    assert.equal(worker.paused, false);
    assert.equal(worker.pauseReason, null);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await worker.stop();
  } finally { h.close(); }
});

test('bad credentials recreate the marker immediately after explicit acknowledgement', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    const marker = join(dirname(h.path), 'worker.pause');
    await writeFile(marker, `${JSON.stringify({ code: 'old-configuration', timestamp: h.clock() })}\n`, { mode: 0o600 });
    h.advance(1);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'bad-config-after-clear');
    const sender = { send: async () => { throw Object.assign(new Error('still bad'), { code: 'messaging/authentication-error' }); } };
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender,
      pollMs: 100_000,
      now: h.clock,
      clearPause: true,
      logger: { error() {} },
    });
    await waitForStatus(h.db, 'failed');
    await waitForFile(marker);
    assert.equal(worker.paused, true);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      code: 'messaging/authentication-error',
      timestamp: h.clock(),
    });
    await worker.stop();
  } finally { h.close(); }
});

test('real sender refuses to start without a non-empty FID allowlist', async () => {
  const previous = process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
  delete process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
  try {
    await assert.rejects(createSender('real'), /PUSH_LAB_REAL_FID_ALLOWLIST is required/);
  } finally {
    if (previous == null) delete process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
    else process.env.PUSH_LAB_REAL_FID_ALLOWLIST = previous;
  }
});

test('real sender requires exact FIDs and an explicit credential path', async () => {
  const previousAllowlist = process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
  const previousCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const previousProject = process.env.FIREBASE_PROJECT_ID;
  try {
    process.env.PUSH_LAB_REAL_FID_ALLOWLIST = '*';
    await assert.rejects(createSender('real'), /must contain exact FIDs/);
    process.env.PUSH_LAB_REAL_FID_ALLOWLIST = 'approved-fid';
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.FIREBASE_PROJECT_ID = 'approved-project';
    await assert.rejects(createSender('real'), /GOOGLE_APPLICATION_CREDENTIALS and FIREBASE_PROJECT_ID are required/);
  } finally {
    if (previousAllowlist == null) delete process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
    else process.env.PUSH_LAB_REAL_FID_ALLOWLIST = previousAllowlist;
    if (previousCredential == null) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredential;
    if (previousProject == null) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previousProject;
  }
});

test('real sender rejects malformed, non-service-account, and wrong-project credentials before Firebase initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'push-lab-credential-test-'));
  const credentialPath = join(directory, 'credential.json');
  const previousAllowlist = process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
  const previousCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const previousProject = process.env.FIREBASE_PROJECT_ID;
  try {
    process.env.PUSH_LAB_REAL_FID_ALLOWLIST = 'approved-fid';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
    process.env.FIREBASE_PROJECT_ID = 'approved-project';
    await writeFile(credentialPath, '{"private_key":"secret-fragment",');
    await assert.rejects(createSender('real'), (error) => {
      assert.equal(error.message, 'Firebase service account configuration invalid');
      assert.doesNotMatch(error.message, /secret-fragment/);
      return true;
    });
    await writeFile(credentialPath, JSON.stringify({ type: 'authorized_user', project_id: 'approved-project' }));
    await assert.rejects(createSender('real'), /Firebase service account configuration invalid/);
    await writeFile(credentialPath, JSON.stringify({ type: 'service_account', project_id: 'foreign-project' }));
    await assert.rejects(createSender('real'), /Firebase service account configuration invalid/);
  } finally {
    if (previousAllowlist == null) delete process.env.PUSH_LAB_REAL_FID_ALLOWLIST;
    else process.env.PUSH_LAB_REAL_FID_ALLOWLIST = previousAllowlist;
    if (previousCredential == null) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredential;
    if (previousProject == null) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previousProject;
    await rm(directory, { recursive: true, force: true });
  }
});

test('real sender rejects a non-allowlisted FID before calling Firebase', async () => {
  let calls = 0;
  const sender = createRealSender({ send: async () => { calls += 1; return 'provider/id'; } }, new Set(['allowed-fid']));
  assert.throws(() => sender.send({ fid: 'other-fid' }), /not in PUSH_LAB_REAL_FID_ALLOWLIST/);
  assert.equal(calls, 0);
  assert.equal(await sender.send({ fid: 'allowed-fid', deliveryId: 'delivery-1', notificationId: 'notice-1', ttlSeconds: 30 }), 'provider/id');
  assert.equal(calls, 1);
});

test('local FID policy rejection fails one attempt without pausing the worker', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'local-policy');
    let calls = 0;
    const sender = createRealSender({ send: async () => { calls += 1; } }, new Set(['different-fid']));
    const worker = await startWorker({ db: h.db, dbPath: h.path, sender, pollMs: 100_000, now: h.clock });
    await waitForStatus(h.db, 'failed');
    assert.equal(worker.paused, false);
    assert.equal(calls, 0);
    assert.equal(h.db.prepare('SELECT last_error_class FROM outbox').get().last_error_class, 'permanent');
    await worker.stop();
  } finally { h.close(); }
});

test('send timeout stays unknown after the uncancellable provider call later succeeds', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'late-provider-success');
    let calls = 0;
    const sender = { send: async () => { calls += 1; await delay(40); return 'provider/late'; } };
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender,
      pollMs: 5,
      senderTimeoutMs: 10,
      now: h.clock,
    });
    await waitForStatus(h.db, 'unknown');
    await delay(60);
    const row = h.db.prepare('SELECT status,attempts,provider_message_id FROM outbox').get();
    assert.equal(row.status, 'unknown');
    assert.equal(row.attempts, 1);
    assert.equal(row.provider_message_id, null);
    assert.equal(calls, 1);
    await worker.stop();
  } finally { h.close(); }
});

test('a timed-out provider call blocks the next claim until its late failure settles', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    const first = h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'first-timeout');
    h.advance(1);
    const second = h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'second-queued');
    let calls = 0;
    const sender = {
      async send() {
        calls += 1;
        if (calls === 1) {
          await delay(50);
          throw Object.assign(new Error('late provider failure'), { code: 'messaging/internal-error' });
        }
        return 'provider/second';
      },
    };
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender,
      pollMs: 2,
      senderTimeoutMs: 10,
      now: h.clock,
    });
    await waitForOutboxStatus(h.db, first.outboxId, 'unknown');
    await delay(20);
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(second.outboxId).status, 'queued');
    assert.equal(calls, 1);
    await waitForOutboxStatus(h.db, second.outboxId, 'accepted');
    assert.equal(h.db.prepare('SELECT status FROM outbox WHERE id=?').get(first.outboxId).status, 'unknown');
    assert.equal(calls, 2);
    await worker.stop();
  } finally { h.close(); }
});

test('independent heartbeats keep a short lease alive during a long provider call', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    const queued = h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'long-provider-call');
    let finishSend;
    const sender = { send: () => new Promise((resolve) => { finishSend = resolve; }) };
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender,
      pollMs: 100_000,
      senderTimeoutMs: 1_000,
      now: h.clock,
      storeOptions: { leaseMs: 60 },
    });
    await waitForOutboxStatus(h.db, queued.outboxId, 'sending');
    const initialLease = h.db.prepare("SELECT lease_until FROM worker_state WHERE name='sender'").get().lease_until;
    h.advance(40);
    await delay(25);
    const renewedLease = h.db.prepare("SELECT lease_until FROM worker_state WHERE name='sender'").get().lease_until;
    assert.ok(renewedLease > initialLease);
    h.advance(40);
    await delay(25);
    assert.equal(worker.paused, false);
    finishSend('provider/long');
    await waitForOutboxStatus(h.db, queued.outboxId, 'accepted');
    await worker.stop();
  } finally { h.close(); }
});

test('lease fencing failure persists a health marker and blocks later claims', async () => {
  const h = harness();
  try {
    const user = onboard(h);
    const logs = [];
    const marker = join(dirname(h.path), 'worker.pause');
    const worker = await startWorker({
      db: h.db,
      dbPath: h.path,
      sender: { send: async () => 'must-not-send' },
      pollMs: 100_000,
      now: h.clock,
      storeOptions: { leaseMs: 30 },
      logger: { error: (...args) => logs.push(args) },
    });
    h.db.prepare("UPDATE worker_state SET owner='forced-owner',version=version+1 WHERE name='sender'").run();
    await waitForFile(marker);
    assert.equal(worker.paused, true);
    assert.equal(worker.pauseReason, 'worker_lease_lost');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      code: 'worker_lease_lost',
      timestamp: h.clock(),
    });
    assert.deepEqual(logs, [['push-lab worker paused', { code: 'worker_lease_lost' }]]);
    h.service.enqueueSelfTest(user.sessionToken, user.csrfToken, user.proofToken, user.deliveryId, 'after-lease-loss');
    assert.equal(await worker.runOnce(), false);
    assert.equal(h.db.prepare("SELECT count(*) AS count FROM outbox WHERE status='queued'").get().count, 1);
    await worker.stop();
  } finally { h.close(); }
});
