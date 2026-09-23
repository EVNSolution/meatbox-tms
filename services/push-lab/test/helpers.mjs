import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { PushLabService } from '../server/service.mjs';

export function harness(start = 1_800_000_000_000, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'push-lab-test-'));
  const path = join(directory, 'push-lab.sqlite');
  let now = start;
  const clock = () => now;
  const db = openDatabase(path);
  const service = new PushLabService(db, { now: clock, selfTestDelayMs: options.selfTestDelayMs ?? 0, firebaseProjectId: options.firebaseProjectId ?? '' });
  return {
    db, service, path, clock,
    advance(ms) { now += ms; },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

export function onboard(h, { userId = 'user-1', deliveryId = 'delivery-1', inviteCode = `invite-${deliveryId}`, session = null, fid = 'fid-1', proof = null, deliverable = true, bootstrapKey = `bootstrap-${deliveryId}-0123456789` } = {}) {
  h.service.createFixture({ userId, deliveryId, inviteCode, deliverable });
  const exchange = h.service.exchangeInvite({ inviteCode, exchangeKey: `exchange-${deliveryId}`, sessionToken: session?.sessionToken });
  const registration = h.service.registerInstallation(exchange.sessionToken, exchange.csrfToken, proof, { fid, provider: 'fcm', projectId: 'test-project', bootstrapKey });
  h.service.subscribe(exchange.sessionToken, exchange.csrfToken, registration.proofToken, deliveryId);
  return { ...exchange, ...registration, deliveryId, bootstrapKey };
}
