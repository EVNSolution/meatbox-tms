import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../server/db.mjs';
import { PushLabService } from '../server/service.mjs';
import { createPushLabServer } from '../server/http.mjs';
import { harness, onboard } from './helpers.mjs';

test('P-07 restart preserves sessions, consent, revocation, and scheduled outbox', () => {
  const directory = mkdtempSync(join(tmpdir(), 'push-lab-persist-'));
  const path = join(directory, 'push-lab.sqlite');
  let db = openDatabase(path);
  try {
    let service = new PushLabService(db, { selfTestDelayMs: 30_000 });
    service.createFixture({ userId: 'user-1', deliveryId: 'delivery-1', inviteCode: 'invite-1' });
    const session = service.exchangeInvite({ inviteCode: 'invite-1', exchangeKey: 'exchange-1' });
    const registration = service.registerInstallation(session.sessionToken, session.csrfToken, null, {
      fid: 'fid-1', provider: 'fcm', projectId: 'test', bootstrapKey: 'persist-bootstrap-0123456789',
    });
    service.subscribe(session.sessionToken, session.csrfToken, registration.proofToken, 'delivery-1');
    const queued = service.enqueueSelfTest(session.sessionToken, session.csrfToken, registration.proofToken, 'delivery-1', 'persist');
    db.close();

    db = openDatabase(path);
    service = new PushLabService(db);
    assert.deepEqual(service.restoreSession(session.sessionToken).deliveryIds, ['delivery-1']);
    assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(queued.outboxId).status, 'queued');
    service.unsubscribe(session.sessionToken, session.csrfToken, registration.proofToken, 'delivery-1');
    db.close();

    db = openDatabase(path);
    assert.equal(db.prepare('SELECT revoked_at IS NOT NULL AS revoked FROM subscriptions').get().revoked, 1);
    assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(queued.outboxId).status, 'cancelled');
  } finally {
    try { db.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v1 upgrades to the current schema once and preserves existing events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'push-lab-migrate-'));
  const path = join(directory, 'push-lab.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  legacy.prepare(`INSERT INTO deliveries(id,user_id,stage,baseline_at,expires_at) VALUES (?,?,?,?,?)`)
    .run('legacy-delivery', 'legacy-user', '배송대기', 1, 9_999_999_999_999);
  legacy.prepare(`INSERT INTO events(id,delivery_id,revision,type,created_at) VALUES (?,?,?,?,?)`)
    .run('legacy-event', 'legacy-delivery', 1, 'legacy', 1);
  legacy.close();
  let upgraded;
  try {
    upgraded = openDatabase(path);
    assert.equal(upgraded.prepare('SELECT max(version) AS version FROM schema_meta').get().version, 5);
    assert.equal(upgraded.prepare("SELECT scope FROM deliveries WHERE id='legacy-delivery'").get().scope, 'test');
    assert.equal(upgraded.prepare("SELECT stage_intent FROM events WHERE id='legacy-event'").get().stage_intent, null);
    upgraded.close();
    upgraded = openDatabase(path);
    assert.equal(upgraded.prepare('SELECT count(*) AS count FROM schema_meta').get().count, 5);
    assert.equal(upgraded.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name='installations_bootstrap_session_idx'").get().count, 0);
  } finally {
    try { upgraded?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two connections serialize the schema v1 migration to the current schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'push-lab-migrate-race-'));
  const path = join(directory, 'push-lab.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  legacy.close();
  const barrier = new SharedArrayBuffer(4);
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const barrier = new Int32Array(workerData.barrier);
    Atomics.add(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 100);
    import(workerData.moduleUrl).then(({ openDatabase }) => {
      const db = openDatabase(workerData.path);
      const version = db.prepare('SELECT max(version) AS version FROM schema_meta').get().version;
      db.close();
      parentPort.postMessage({ version });
    }).catch((error) => parentPort.postMessage({ error: error.stack }));
  `;
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { barrier, path, moduleUrl: new URL('../server/db.mjs', import.meta.url).href } });
    worker.once('message', (message) => message.error ? reject(new Error(message.error)) : resolve(message.version));
    worker.once('error', reject);
  });
  try {
    assert.deepEqual(await Promise.all([run(), run()]), [5, 5]);
    const db = openDatabase(path);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_meta').get().count, 5);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('P-07 a database write failure is returned as failure and commits no self-test', async () => {
  const h = harness();
  const user = onboard(h);
  const origin = 'https://push.test';
  const server = createPushLabServer({ db: h.db, service: h.service, origin, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    h.db.exec('PRAGMA query_only=ON');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/push-lab/api/deliveries/${user.deliveryId}/self-test`, {
      method: 'POST',
      headers: {
        origin,
        cookie: `mb_push_session=${user.sessionToken}; mb_push_installation=${user.proofToken}`,
        'x-csrf-token': user.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey: 'write-failure' }),
    });
    assert.equal(response.status, 500);
    h.db.exec('PRAGMA query_only=OFF');
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM self_test_requests').get().count, 0);
    assert.equal(h.db.prepare('SELECT count(*) AS count FROM outbox').get().count, 0);
  } finally {
    h.db.exec('PRAGMA query_only=OFF');
    await new Promise((resolve) => server.close(resolve));
    h.close();
  }
});
