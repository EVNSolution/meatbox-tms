// Run as the dedicated pilot user with Node 26; never against the TMS state.
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, createReadStream, mkdirSync, mkdtempSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

process.umask(0o077);
const sourcePath = process.env.DB_PATH;
const backupDir = process.env.PUSH_LAB_BACKUP_DIR;
const appDir = process.env.PUSH_LAB_APP_DIR;
if (!sourcePath || !backupDir || !appDir) {
  throw new Error('DB_PATH, PUSH_LAB_BACKUP_DIR and PUSH_LAB_APP_DIR are required');
}
const { openDatabase, SCHEMA_VERSION } = await import(pathToFileURL(resolve(appDir, 'server/db.mjs')).href);
const digestFile = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const sourceRows = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name",
).all().map(({ name }) => {
  const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
  const names = columns.map((column) => column.name);
  const key = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  const sql = `SELECT ${names.map(quote).join(', ')} FROM ${quote(name)} ORDER BY ${(key.length ? key : names).map(quote).join(', ')}`;
  const digest = createHash('sha256').update(JSON.stringify(names));
  let count = 0;
  for (const row of db.prepare(sql).iterate()) {
    digest.update(`${JSON.stringify(row)}\n`);
    count += 1;
  }
  return { name, names, key, count, digest: digest.digest('hex') };
});
const inspect = (db, at) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).count;
  return {
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
    schemaVersion: db.prepare('SELECT max(version) AS version FROM schema_meta').get().version,
    subscriptionsActive: count('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NULL AND expires_at>?', at),
    subscriptionsRevoked: count('SELECT count(*) AS count FROM subscriptions WHERE revoked_at IS NOT NULL'),
    outboxQueued: count("SELECT count(*) AS count FROM outbox WHERE status='queued'"),
    outboxCancelled: count("SELECT count(*) AS count FROM outbox WHERE status='cancelled'"),
  };
};
const verify = (state, schemaVersion) => {
  if (!Number.isInteger(state.schemaVersion) || state.integrity !== 'ok'
    || state.foreignKeyViolations !== 0 || state.schemaVersion !== schemaVersion) {
    throw new Error('backup or restore integrity/schema check failed');
  }
};

mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const backupName = `push-lab-${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..+/, 'Z')}-${randomUUID()}.sqlite`;
const backupPath = join(backupDir, backupName);
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, backupPath);
} finally {
  source.close();
}
chmodSync(backupPath, 0o600);

const classifiedAtMs = Date.now();
const snapshot = new DatabaseSync(backupPath, { readOnly: true });
let original;
let rows;
try {
  original = inspect(snapshot, classifiedAtMs);
  verify(original, original.schemaVersion);
  if (original.schemaVersion !== SCHEMA_VERSION) throw new Error('native backup check requires the current schema');
  rows = sourceRows(snapshot);
} finally {
  snapshot.close();
}
const backupSha256 = await digestFile(backupPath);
const manifestPath = `${backupPath}.manifest.json`;
const restoreDir = mkdtempSync(join(tmpdir(), 'push-lab-native-restore-'));
try {
  const restoredPath = join(restoreDir, backupName);
  copyFileSync(backupPath, restoredPath);
  if (await digestFile(restoredPath) !== backupSha256) throw new Error('restore copy hash mismatch');
  const restored = openDatabase(restoredPath);
  try {
    const current = inspect(restored, classifiedAtMs);
    verify(current, SCHEMA_VERSION);
    for (const field of ['subscriptionsActive', 'subscriptionsRevoked', 'outboxQueued', 'outboxCancelled']) {
      if (current[field] !== original[field]) throw new Error(`restore state changed: ${field}`);
    }
    const copiedRows = sourceRows(restored);
    for (const row of rows) {
      const copied = copiedRows.find((entry) => entry.name === row.name);
      if (!copied || copied.digest !== row.digest || copied.count !== row.count) {
        throw new Error(`source rows changed during restore migration: ${row.name}`);
      }
    }
  } finally {
    restored.close();
  }
} finally {
  rmSync(restoreDir, { recursive: true, force: true });
}
writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify({
  formatVersion: 1,
  backupFile: basename(backupPath),
  createdAt: new Date(classifiedAtMs).toISOString(),
  backupSha256,
  ...original,
  sourceTablesCompared: rows.length,
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
renameSync(`${manifestPath}.tmp`, manifestPath);
console.log(JSON.stringify({
  backup: backupPath,
  manifest: manifestPath,
  backupSha256,
  sourceSchemaVersion: original.schemaVersion,
  currentSchemaVersion: SCHEMA_VERSION,
  integrity: original.integrity,
  foreignKeyViolations: original.foreignKeyViolations,
  sourceRowsPreserved: true,
  sourceTablesCompared: rows.length,
  subscriptionsActive: original.subscriptionsActive,
  subscriptionsRevoked: original.subscriptionsRevoked,
  outboxQueued: original.outboxQueued,
  outboxCancelled: original.outboxCancelled,
  senderMode: 'not-started',
}));
