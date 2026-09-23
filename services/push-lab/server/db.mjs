import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
export const SCHEMA_VERSION = 5;

export function openDatabase(path = process.env.DB_PATH || './data/push-lab.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const [major, minor, patch] = db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    db.close();
    throw new Error('SQLite 3.51.3 or newer is required');
  }
  for (const file of readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    const version = Number(file.split('_', 1)[0]);
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
      const applied = hasMeta && db.prepare('SELECT 1 FROM schema_meta WHERE version=?').get(version);
      if (!applied) {
        db.exec(readFileSync(resolve(migrationsDirectory, file), 'utf8'));
        if (!db.prepare('SELECT 1 FROM schema_meta WHERE version=?').get(version)) throw new Error(`migration ${file} did not record version ${version}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
