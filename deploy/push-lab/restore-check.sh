#!/bin/sh
set -eu

backup_name=${1:?usage: ./restore-check.sh push-lab-YYYYmmddTHHMMSSZ.sqlite [service]}
service=${2:-push-lab}

case "$backup_name" in
  */*|*..*) echo "backup_name must be a file name from /var/backups/push-lab" >&2; exit 64 ;;
esac

docker compose exec -T -e BACKUP_NAME="$backup_name" "$service" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from './server/db.mjs';

const source = `/var/backups/push-lab/${process.env.BACKUP_NAME}`;
const manifest = JSON.parse(readFileSync(`${source}.manifest.json`, 'utf8'));
const restored = `/tmp/push-lab-restore-check-${process.pid}.sqlite`;
const cleanup = () => {
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${restored}${suffix}`, { force: true });
};
cleanup();
copyFileSync(source, restored);

const countSummary = (db, classifiedAtMs) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).count;
  const outbox = Object.fromEntries(
    ['queued', 'sending', 'retrying', 'accepted', 'unknown', 'expired', 'cancelled', 'failed'].map((status) => [
      status,
      count('SELECT count(*) AS count FROM outbox WHERE status=?', status),
    ]),
  );
  return {
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
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const sourceRows = (db) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name").all();
  return tables.map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const names = columns.map(({ name: column }) => column);
    const key = columns.filter(({ pk }) => pk).sort((a, b) => a.pk - b.pk).map(({ name: column }) => column);
    const select = `SELECT ${names.map(quote).join(', ')} FROM ${quote(name)} ORDER BY ${(key.length ? key : names).map(quote).join(', ')}`;
    const digest = createHash('sha256');
    for (const row of db.prepare(select).iterate()) digest.update(`${JSON.stringify(row)}\n`);
    return { name, names, key, digest: digest.digest('hex') };
  });
};
const verifyRows = (db, tables) => {
  for (const { name, names, key, digest: expected } of tables) {
    const select = `SELECT ${names.map(quote).join(', ')} FROM ${quote(name)} ORDER BY ${(key.length ? key : names).map(quote).join(', ')}`;
    const digest = createHash('sha256');
    for (const row of db.prepare(select).iterate()) digest.update(`${JSON.stringify(row)}\n`);
    if (digest.digest('hex') !== expected) throw new Error(`source rows changed during migration: ${name}`);
  }
};
const inspect = (db) => {
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  const schemaVersion = db.prepare('SELECT max(version) AS version FROM schema_meta').get().version;
  const summary = countSummary(db, manifest.classifiedAtMs);
  return { integrity, foreignKeyViolations, schemaVersion, summary, stateDigest: sha256(JSON.stringify(summary)) };
};
const verifyState = (actual, expectedSchemaVersion) => {
  if (actual.integrity !== 'ok') throw new Error(`integrity_check failed: ${actual.integrity}`);
  if (actual.foreignKeyViolations !== 0) throw new Error(`foreign_key_check failed: ${actual.foreignKeyViolations} row(s)`);
  if (actual.schemaVersion !== expectedSchemaVersion) throw new Error(`schema mismatch: expected ${expectedSchemaVersion}, got ${actual.schemaVersion}`);
  if (actual.stateDigest !== manifest.stateDigest || JSON.stringify(actual.summary) !== JSON.stringify(manifest.summary)) {
    throw new Error('snapshot state summary/digest does not match the backup manifest');
  }
};

try {
  if (manifest.formatVersion !== 1 || manifest.backupFile !== process.env.BACKUP_NAME) throw new Error('invalid backup manifest');
  if (!Number.isInteger(manifest.classifiedAtMs) || !Number.isInteger(manifest.schemaVersion)) throw new Error('invalid backup manifest metadata');
  if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error(`backup schema ${manifest.schemaVersion} is newer than supported schema ${SCHEMA_VERSION}`);
  const backupSha256 = sha256(readFileSync(restored));
  if (backupSha256 !== manifest.backupSha256) throw new Error('backup file SHA-256 does not match the manifest');

  const snapshot = new DatabaseSync(restored, { readOnly: true });
  let originalRows;
  try {
    verifyState(inspect(snapshot), manifest.schemaVersion);
    originalRows = sourceRows(snapshot);
  } finally {
    snapshot.close();
  }

  const compatible = openDatabase(restored);
  let migrated;
  try {
    const result = inspect(compatible);
    verifyState(result, SCHEMA_VERSION);
    verifyRows(compatible, originalRows);
    migrated = result;
  } finally {
    compatible.close();
  }

  console.log(JSON.stringify({
    restored,
    backupSha256,
    sourceSchemaVersion: manifest.schemaVersion,
    currentSchemaVersion: migrated.schemaVersion,
    migrated: manifest.schemaVersion < migrated.schemaVersion,
    integrity: migrated.integrity,
    foreignKeyViolations: migrated.foreignKeyViolations,
    stateDigest: migrated.stateDigest,
    sourceRowsPreserved: true,
    sourceTablesCompared: originalRows.length,
    summary: migrated.summary,
    senderMode: 'not-started',
  }));
} finally {
  cleanup();
}
NODE
