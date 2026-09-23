#!/bin/sh
set -eu

service=${1:-push-lab}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/var/backups/push-lab/push-lab-${stamp}.sqlite"

docker compose exec -T -e BACKUP_TARGET="$target" "$service" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const source = process.env.DB_PATH;
const target = process.env.BACKUP_TARGET;
if (!source || !target) throw new Error('DB_PATH and BACKUP_TARGET are required');

const db = new DatabaseSync(source, { open: true });
try {
  await backup(db, target);
} finally {
  db.close();
}

const classifiedAtMs = Date.now();
const snapshot = new DatabaseSync(target, { readOnly: true });
let manifest;
try {
  const integrity = snapshot.prepare('PRAGMA integrity_check').get().integrity_check;
  const foreignKeyViolations = snapshot.prepare('PRAGMA foreign_key_check').all().length;
  if (integrity !== 'ok') throw new Error(`backup integrity_check failed: ${integrity}`);
  if (foreignKeyViolations !== 0) throw new Error(`backup foreign_key_check failed: ${foreignKeyViolations} row(s)`);

  const count = (sql, ...params) => snapshot.prepare(sql).get(...params).count;
  const outbox = Object.fromEntries(
    ['queued', 'sending', 'retrying', 'accepted', 'unknown', 'expired', 'cancelled', 'failed'].map((status) => [
      status,
      count('SELECT count(*) AS count FROM outbox WHERE status=?', status),
    ]),
  );
  const summary = {
    sessions: {
      total: count('SELECT count(*) AS count FROM sessions'),
      active: count('SELECT count(*) AS count FROM sessions WHERE expires_at > ?', classifiedAtMs),
      expired: count('SELECT count(*) AS count FROM sessions WHERE expires_at <= ?', classifiedAtMs),
    },
    installations: {
      total: count('SELECT count(*) AS count FROM installations'),
      active: count('SELECT count(*) AS count FROM installations WHERE active=1'),
      inactive: count('SELECT count(*) AS count FROM installations WHERE active=0'),
    },
    subscriptions: {
      total: count('SELECT count(*) AS count FROM subscriptions'),
      active: count('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NULL AND expires_at > ?', classifiedAtMs),
      revoked: count('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NOT NULL'),
      expired: count('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NULL AND expires_at <= ?', classifiedAtMs),
    },
    outbox: { total: count('SELECT count(*) AS count FROM outbox'), ...outbox },
    workerState: {
      total: count('SELECT count(*) AS count FROM worker_state'),
      activeLeases: count('SELECT count(*) AS count FROM worker_state WHERE lease_until > ?', classifiedAtMs),
      expiredLeases: count('SELECT count(*) AS count FROM worker_state WHERE lease_until <= ?', classifiedAtMs),
    },
  };
  const stateDigest = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  manifest = {
    formatVersion: 1,
    backupFile: basename(target),
    createdAt: new Date(classifiedAtMs).toISOString(),
    classifiedAtMs,
    schemaVersion: snapshot.prepare('SELECT max(version) AS version FROM schema_meta').get().version,
    sqliteVersion: snapshot.prepare('SELECT sqlite_version() AS version').get().version,
    integrity,
    foreignKeyViolations,
    summary,
    stateDigest,
    backupSha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
  };
} finally {
  snapshot.close();
}

const manifestPath = `${target}.manifest.json`;
const temporaryManifestPath = `${manifestPath}.tmp`;
writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryManifestPath, manifestPath);
console.log(JSON.stringify({
  backup: target,
  manifest: manifestPath,
  sha256: manifest.backupSha256,
  schemaVersion: manifest.schemaVersion,
  foreignKeyViolations: manifest.foreignKeyViolations,
  stateDigest: manifest.stateDigest,
  summary: manifest.summary,
}));
NODE
