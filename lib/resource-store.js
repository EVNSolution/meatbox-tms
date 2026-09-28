'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const codePattern = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const shaPattern = /^[a-f0-9]{64}$/;

class ResourceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function regionCode(value) {
  if (typeof value !== 'string' || !codePattern.test(value)) throw new ResourceError(400, 'INVALID_REGION_CODE', '지역 코드는 영문자로 시작하고 영문·숫자만 사용할 수 있습니다.');
  return value.toUpperCase();
}

const vehicleTable = name => `CREATE TABLE ${name} (id TEXT PRIMARY KEY, plate TEXT NOT NULL, original_code TEXT,
  active INTEGER NOT NULL CHECK (active IN (0,1)), region_code TEXT REFERENCES region_codes(code) ON UPDATE CASCADE,
  CHECK (active=1 OR region_code IS NULL),
  CHECK (region_code IS NULL OR (length(region_code) BETWEEN 1 AND 40 AND
    substr(region_code,1,1) GLOB '[A-Z]' AND region_code NOT GLOB '*[^A-Z0-9]*')))`;
const regionCodesTable = `CREATE TABLE region_codes (code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 40 AND
  substr(code,1,1) GLOB '[A-Z]' AND code NOT GLOB '*[^A-Z0-9]*'))`;
function migrateV1(db) {
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const codes = db.prepare('SELECT code FROM categories').all().map(row => regionCode(row.code));
      if (new Set(codes).size !== codes.length) throw new Error('Duplicate normalized region code');
      const known = new Set(codes);
      for (const row of db.prepare('SELECT category_code AS code FROM vehicles WHERE active=1').all()) {
        if (row.code !== null && !known.has(regionCode(row.code))) throw new Error('Unknown v1 region code');
      }
      db.exec(`${regionCodesTable}; ${vehicleTable('vehicles_v2')};`);
      const insertCode = db.prepare('INSERT INTO region_codes(code) VALUES (?)');
      for (const code of codes) insertCode.run(code);
      db.exec(`
        INSERT INTO vehicles_v2(id,plate,original_code,active,region_code)
          SELECT id,plate,original_code,active,CASE WHEN active=1 THEN UPPER(category_code) ELSE NULL END FROM vehicles;
        DROP TABLE vehicles;
        ALTER TABLE vehicles_v2 RENAME TO vehicles;
        DROP TABLE categories;
        PRAGMA user_version=2;`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}

function openExisting(filename) {
  if (!filename || !fs.existsSync(filename)) throw new ResourceError(503, 'RESOURCE_DATABASE_UNAVAILABLE', '자원 등록부를 사용할 수 없습니다.');
  let db;
  try {
    db = new DatabaseSync(filename);
    db.exec('PRAGMA foreign_keys = ON');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![1, 2].includes(version) || !db.prepare('SELECT fingerprint FROM source_catalog WHERE id=1').get()) throw new Error('Invalid resource database');
    if (version === 1) migrateV1(db);
    return db;
  } catch {
    db?.close();
    throw new ResourceError(503, 'RESOURCE_DATABASE_UNAVAILABLE', '자원 등록부를 사용할 수 없습니다.');
  }
}

function createResourceStore(filename) {
  let db;
  const database = () => (db ||= openExisting(filename));
  function snapshot() {
    const connection = database();
    connection.exec('BEGIN');
    try {
      const source = connection.prepare('SELECT kind, imported_count AS importedCount, excluded_count AS excludedCount, revision FROM source_catalog WHERE id=1').get();
      const result = { revision: source.revision,
        regionCodes: connection.prepare('SELECT code FROM region_codes ORDER BY code').all(),
        vehicles: connection.prepare('SELECT id, plate, region_code AS regionCode FROM vehicles WHERE active=1 ORDER BY region_code IS NULL, region_code, plate, id').all(),
        source: { kind: source.kind, importedCount: source.importedCount, excludedCount: source.excludedCount } };
      connection.exec('COMMIT');
      return result;
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  }
  function mutate(revision, action) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ResourceError(400, 'INVALID_REVISION', '최신 자원 정보를 다시 불러와 주세요.');
    const connection = database();
    connection.exec('BEGIN IMMEDIATE');
    try {
      const current = connection.prepare('SELECT revision FROM source_catalog WHERE id=1').get().revision;
      if (current !== revision) throw new ResourceError(409, 'RESOURCE_REVISION_CONFLICT', '자원 등록부가 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      action(connection);
      connection.prepare('UPDATE source_catalog SET revision=revision+1 WHERE id=1').run();
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
    return snapshot();
  }
  function assignVehicles(revision, assignments) {
    if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > 1000) {
      throw new ResourceError(400, 'INVALID_ASSIGNMENTS', '변경할 차량을 1~1000개 선택해 주세요.');
    }
    const ids = new Set();
    const changes = assignments.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'regionCode') ||
        typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)) {
        throw new ResourceError(400, 'INVALID_ASSIGNMENTS', '차량 목록에 중복되거나 잘못된 항목이 있습니다.');
      }
      ids.add(item.id);
      return { id: item.id, code: item.regionCode === null ? null : regionCode(item.regionCode) };
    });
    return mutate(revision, connection => {
      const activeIds = new Set(connection.prepare('SELECT id FROM vehicles WHERE active=1').all().map(row => row.id));
      const knownCodes = new Set(connection.prepare('SELECT code FROM region_codes').all().map(row => row.code));
      for (const change of changes) {
        if (!activeIds.has(change.id)) throw new ResourceError(404, 'VEHICLE_NOT_FOUND', '활성 차량을 찾을 수 없습니다.');
        if (change.code !== null && !knownCodes.has(change.code)) throw new ResourceError(400, 'REGION_CODE_NOT_FOUND', '등록된 지역 코드를 선택해 주세요.');
      }
      const update = connection.prepare('UPDATE vehicles SET region_code=? WHERE id=?');
      for (const change of changes) update.run(change.code, change.id);
    });
  }
  return {
    snapshot,
    createRegionCode(revision, code) {
      const normalized = regionCode(code);
      return mutate(revision, connection => {
        if (connection.prepare('SELECT 1 FROM region_codes WHERE code=?').get(normalized)) throw new ResourceError(409, 'REGION_CODE_EXISTS', '이미 등록된 지역 코드입니다.');
        connection.prepare('INSERT INTO region_codes(code) VALUES (?)').run(normalized);
      });
    },
    renameRegionCode(revision, oldCode, newCode) {
      const oldNormalized = regionCode(oldCode), normalized = regionCode(newCode);
      return mutate(revision, connection => {
        if (!connection.prepare('SELECT 1 FROM region_codes WHERE code=?').get(oldNormalized)) throw new ResourceError(404, 'REGION_CODE_NOT_FOUND', '지역 코드를 찾을 수 없습니다.');
        if (connection.prepare('SELECT 1 FROM region_codes WHERE code=?').get(normalized)) throw new ResourceError(409, 'REGION_CODE_EXISTS', '이미 등록된 지역 코드입니다.');
        connection.prepare('UPDATE region_codes SET code=? WHERE code=?').run(normalized, oldNormalized);
      });
    },
    assignVehicles,
    assignVehicle(revision, id, code) { return assignVehicles(revision, [{ id, regionCode: code }]); },
    close() { db?.close(); db = null; },
  };
}

function importResourceCatalog({ output, fingerprint, vehicles }) {
  if (!path.isAbsolute(output) || !shaPattern.test(fingerprint || '') || !Array.isArray(vehicles) || !vehicles.length ||
    vehicles.some(vehicle => !vehicle || typeof vehicle.id !== 'string' || !vehicle.id ||
      typeof vehicle.plate !== 'string' || !vehicle.plate || typeof vehicle.active !== 'boolean' ||
      (vehicle.active ? typeof vehicle.originalCode !== 'string' || !codePattern.test(vehicle.originalCode)
        : vehicle.originalCode !== null)) || new Set(vehicles.map(vehicle => vehicle.id)).size !== vehicles.length) {
    throw new Error('Invalid resource catalog input');
  }
  if (fs.existsSync(output)) {
    const existing = new DatabaseSync(output, { readOnly: true });
    try {
      const source = existing.prepare('SELECT fingerprint, imported_count AS importedCount FROM source_catalog WHERE id=1').get();
      if (source.fingerprint !== fingerprint || source.importedCount !== vehicles.length) throw new Error('Resource database belongs to another source');
    } finally { existing.close(); }
    const verified = openExisting(output);
    verified.close();
    return 'unchanged';
  }
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(output, 'wx', 0o600);
  fs.closeSync(descriptor);
  let db;
  try {
    db = new DatabaseSync(output);
    db.exec(`PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE source_catalog (id INTEGER PRIMARY KEY CHECK (id=1), fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL, imported_count INTEGER NOT NULL, excluded_count INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0);
      ${regionCodesTable};
      ${vehicleTable('vehicles')};
      PRAGMA user_version = 2;`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const active = vehicles.filter(vehicle => vehicle.active);
      const insertCode = db.prepare('INSERT INTO region_codes(code) VALUES (?)');
      for (const code of new Set(active.map(vehicle => regionCode(vehicle.originalCode)))) insertCode.run(code);
      const insertVehicle = db.prepare('INSERT INTO vehicles(id,plate,original_code,active,region_code) VALUES (?,?,?,?,?)');
      for (const vehicle of vehicles) {
        const code = vehicle.active ? regionCode(vehicle.originalCode) : null;
        insertVehicle.run(vehicle.id, vehicle.plate, vehicle.originalCode, vehicle.active ? 1 : 0, code);
      }
      db.prepare('INSERT INTO source_catalog(id,fingerprint,kind,imported_count,excluded_count,revision) VALUES (1,?,?,?,?,0)')
        .run(fingerprint, 'legacy_vehicle_catalog', vehicles.length, vehicles.length - active.length);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return 'imported';
  } catch (error) {
    db?.close();
    db = null;
    fs.rmSync(output, { force: true });
    throw error;
  } finally { db?.close(); }
}

module.exports = { createResourceStore, importResourceCatalog, ResourceError };
