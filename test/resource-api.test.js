'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createDemo } = require('../server');

const origin = 'http://127.0.0.1:34568';
const script = path.join(__dirname, '../scripts/import-resource-catalog.mjs');
const labels = Array.from({ length: 155 }, (_, index) => index < 31
  ? `(Z${String(index + 1).padStart(3, '0')}) 한국어 이름` : index === 31 ? '(강남B) 한국어 이름'
    : index === 32 ? '(마포B) 한국어 이름' : index === 33 ? '(Z999) 용차'
      : `한국어 기사 ${index}`);
const day = (labelsToUse = labels) => ({ schemaVersion: 1, date: '2026-09-16',
  groups: labelsToUse.map((label, index) => ({ id: `G${index + 1}`, label, regionNames: ['서울'] })), orders: [] });

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'day.json');
  const output = path.join(dir, 'private', 'resources.sqlite');
  fs.writeFileSync(input, JSON.stringify(day()));
  const run = () => spawnSync(process.execPath, [script, '--day', input, '--output', output], { encoding: 'utf8' });
  return { dir, input, output, run };
}

function v1Fixture(output, secondCode = 'Z002') {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const db = new DatabaseSync(output);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE source_catalog (id INTEGER PRIMARY KEY CHECK (id=1), fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL, imported_count INTEGER NOT NULL, excluded_count INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE categories (code TEXT PRIMARY KEY);
    CREATE TABLE vehicles (id TEXT PRIMARY KEY, plate TEXT NOT NULL, original_code TEXT,
      active INTEGER NOT NULL CHECK (active IN (0,1)), category_code TEXT REFERENCES categories(code) ON UPDATE CASCADE,
      CHECK (active=1 OR category_code IS NULL));
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO source_catalog VALUES (1,?,?,?,?,?)').run('f'.repeat(64), 'legacy_vehicle_catalog', 3, 1, 7);
  db.prepare('INSERT INTO categories VALUES (?)').run('Z001');
  if (secondCode !== 'Z001') db.prepare('INSERT INTO categories VALUES (?)').run(secondCode);
  db.prepare('INSERT INTO categories VALUES (?)').run('UNUSED');
  const insert = db.prepare('INSERT INTO vehicles VALUES (?,?,?,?,?)');
  insert.run('G1', '11가 1001', 'Z001', 1, 'Z001');
  insert.run('G2', '12나 1002', secondCode, 1, secondCode);
  insert.run('G3', '13다 1003', null, 0, null);
  db.close();
}

async function app(t, filename) {
  const demo = createDemo({ origin, resourceDatabasePath: filename,
    access: { session: async token => token === 'test' ? { username: 'test' } : null } });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(() => demo.close());
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  const request = (route, options = {}) => fetch(base + route, { ...options,
    headers: { cookie: 'meatbox_session=test', ...options.headers } });
  return { request, demo };
}

test('explicit import preserves every ID and plate, excludes unverified labels, and stores no operations', async t => {
  const f = setup(t);
  assert.equal(f.run().status, 0);
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.output)).mode & 0o777, 0o700);
  const db = new DatabaseSync(f.output, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const rows = db.prepare('SELECT id, plate, original_code AS originalCode, region_code AS regionCode, active FROM vehicles ORDER BY id').all();
  assert.equal(rows.length, 155);
  assert.equal(rows.filter(row => row.active).length, 31);
  assert.equal(rows.filter(row => !row.active).length, 124);
  assert.equal(rows.find(row => row.id === 'G1').originalCode, 'Z001');
  assert.equal(rows.find(row => row.id === 'G1').regionCode, 'Z001');
  assert.equal(rows.find(row => row.id === 'G32').originalCode, null);
  assert.equal(rows.find(row => row.id === 'G34').originalCode, null);
  assert.equal(new Set(rows.map(row => row.plate)).size, 155);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all().map(row => row.sql).join(' ');
  assert.doesNotMatch(schema, /CREATE TABLE categories/i);
  assert.match(schema, /CREATE TABLE region_codes/i);
  for (const forbidden of ['orders', 'destinations', 'boxes', 'location', 'driver', 'shipment']) assert.doesNotMatch(schema.toLowerCase(), new RegExp(forbidden));
  const content = fs.readFileSync(f.output);
  assert.equal(content.includes(Buffer.from('한국어')), false);
  db.close();
  const { request } = await app(t, f.output);
  const body = await (await request('/api/resources')).json();
  assert.equal(body.revision, 0);
  assert.equal(body.categories, undefined);
  assert.equal(body.regionCodes.length, 31);
  assert.equal(body.vehicles.length, 31);
  assert.deepEqual(body.source, { kind: 'legacy_vehicle_catalog', importedCount: 155, excludedCount: 124 });
  assert.deepEqual(Object.keys(body.vehicles[0]).sort(), ['id', 'plate', 'regionCode']);
});

test('same source import is idempotent and a different source is rejected without losing edits', async t => {
  const f = setup(t);
  assert.equal(f.run().status, 0);
  const { request } = await app(t, f.output);
  const post = (route, method, body) => request(route, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/resources/region-codes', 'POST', { revision: 0, code: 'NEW' })).status, 200);
  assert.equal((await post('/api/resources/vehicles/G1', 'PATCH', { revision: 1, regionCode: 'NEW' })).status, 200);
  assert.equal(f.run().status, 0);
  assert.equal((await (await request('/api/resources')).json()).revision, 2);
  fs.writeFileSync(f.input, JSON.stringify(day([...labels.slice(0, 154), 'changed label'])));
  assert.notEqual(f.run().status, 0);
  assert.equal((await (await request('/api/resources')).json()).revision, 2);
});

test('region links use authentication, origin, validation, CAS, and persist across restart', async t => {
  const f = setup(t);
  assert.equal(f.run().status, 0);
  const first = await app(t, f.output);
  const post = (route, method, body, requestOrigin = origin) => first.request(route, { method,
    headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await first.request('/api/resources', { headers: { cookie: '' } })).status, 401);
  assert.equal((await post('/api/resources/vehicles/G1', 'PATCH', { revision: 0, regionCode: 'NEW' }, 'https://evil.invalid')).status, 403);
  assert.equal((await post('/api/resources/categories', 'POST', { revision: 0, code: 'NEW' })).status, 404);
  const unknownCode = await post('/api/resources/vehicles/G1', 'PATCH', { revision: 0, regionCode: 'NEW' });
  assert.equal(unknownCode.status, 400);
  assert.equal((await unknownCode.json()).error, 'REGION_CODE_NOT_FOUND');
  for (const body of [{ revision: 0, regionCode: '한글' }, { revision: 0, regionCode: 'NEW', extra: 1 }, { regionCode: 'NEW' }]) {
    assert.equal((await post('/api/resources/vehicles/G1', 'PATCH', body)).status, 400);
  }
  assert.equal((await post('/api/resources/vehicles/UNKNOWN', 'PATCH', { revision: 0, regionCode: 'Z001' })).status, 404);
  assert.equal((await post('/api/resources/vehicles/G32', 'PATCH', { revision: 0, regionCode: 'Z001' })).status, 404);
  assert.equal((await post('/api/resources/region-codes', 'POST', { revision: 0, code: '한글' })).status, 400);
  assert.equal((await post('/api/resources/region-codes', 'POST', { revision: 0, code: 'NEW' }, 'https://evil.invalid')).status, 403);
  const created = await (await post('/api/resources/region-codes', 'POST', { revision: 0, code: 'new' })).json();
  assert.equal(created.revision, 1);
  assert.ok(created.regionCodes.some(item => item.code === 'NEW'));
  const duplicateCode = await post('/api/resources/region-codes', 'POST', { revision: 1, code: 'NEW' });
  assert.equal(duplicateCode.status, 409);
  assert.equal((await duplicateCode.json()).error, 'REGION_CODE_EXISTS');
  const assigned = await (await post('/api/resources/vehicles/G1', 'PATCH', { revision: 1, regionCode: 'new' })).json();
  assert.equal(assigned.revision, 2);
  assert.equal(assigned.vehicles.find(item => item.id === 'G1').regionCode, 'NEW');
  const shared = await (await post('/api/resources/vehicles/G2', 'PATCH', { revision: 2, regionCode: 'new' })).json();
  assert.equal(shared.revision, 3);
  assert.equal(shared.vehicles.find(item => item.id === 'G2').regionCode, 'NEW');
  const renamed = await (await post('/api/resources/region-codes/NEW', 'PATCH', { revision: 3, code: 'NEXT' })).json();
  assert.equal(renamed.revision, 4);
  assert.equal(renamed.vehicles.filter(item => item.regionCode === 'NEXT').length, 2);
  assert.ok(renamed.regionCodes.some(item => item.code === 'NEXT'));
  assert.equal((await post('/api/resources/region-codes/NEXT', 'PATCH', { revision: 4, code: 'Z001' })).status, 409);
  assert.equal((await post('/api/resources/vehicles/G1', 'PATCH', { revision: 0, regionCode: null })).status, 409);
  const cleared = await (await post('/api/resources/vehicles/G1', 'PATCH', { revision: 4, regionCode: null })).json();
  assert.equal(cleared.revision, 5);
  await first.demo.close();
  const second = await app(t, f.output);
  const snapshot = await (await second.request('/api/resources')).json();
  assert.equal(snapshot.revision, 5);
  assert.equal(snapshot.vehicles.find(item => item.id === 'G1').regionCode, null);
  assert.equal(snapshot.vehicles.find(item => item.id === 'G2').regionCode, 'NEXT');
  assert.equal(snapshot.vehicles.at(-1).id, 'G1');
});

test('without resource configuration the API is unavailable and does not import legacy data', async t => {
  const { request } = await app(t, undefined);
  assert.equal((await request('/api/resources')).status, 503);
  assert.equal((await request('/api/resources/vehicles', { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 503);
});

test('missing runtime database and unrelated import output are never created or changed', async t => {
  const f = setup(t);
  const { request } = await app(t, f.output);
  assert.equal((await request('/api/resources')).status, 503);
  assert.equal(fs.existsSync(f.output), false);
  const parent = path.dirname(f.output);
  assert.equal(fs.existsSync(parent), false);
  fs.mkdirSync(parent);
  const unrelated = new DatabaseSync(f.output);
  unrelated.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');");
  unrelated.close();
  const before = fs.readFileSync(f.output);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(fs.readFileSync(f.output), before);
  assert.equal((await request('/api/resources')).status, 503);
});

test('bulk vehicle assignments validate all entries and commit once with one revision', async t => {
  const f = setup(t);
  assert.equal(f.run().status, 0);
  const first = await app(t, f.output);
  const patch = (body, requestOrigin = origin) => first.request('/api/resources/vehicles', { method: 'PATCH',
    headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const before = await (await first.request('/api/resources')).json();
  const assignments = [{ id: 'G1', regionCode: 'Z002' }, { id: 'G2', regionCode: 'Z001' }];
  assert.equal((await patch({ revision: 0, assignments }, 'https://evil.invalid')).status, 403);
  assert.equal((await first.request('/api/resources/vehicles', { method: 'PATCH',
    headers: { cookie: '', origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, assignments }) })).status, 401);
  const badBatches = [
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'G1', regionCode: null }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'UNKNOWN', regionCode: null }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'G32', regionCode: null }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'G2', regionCode: 'MISSING' }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'G2', regionCode: '한글' }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'G2', regionCode: null, extra: 1 }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 2, regionCode: null }],
    [{ id: 'G1', regionCode: 'Z002' }, { id: 'X'.repeat(201), regionCode: null }],
    [],
    Array.from({ length: 1001 }, (_, index) => ({ id: `X${index}`, regionCode: null })),
  ];
  for (const entries of badBatches) {
    const response = await patch({ revision: 0, assignments: entries });
    assert.ok([400, 404].includes(response.status), `${entries.length}: ${response.status}`);
    assert.deepEqual(await (await first.request('/api/resources')).json(), before);
  }
  for (const body of [{ revision: 0, assignments, extra: 1 }, { assignments },
    { revision: 0, assignments: 'bad' }, { revision: -1, assignments }]) {
    assert.equal((await patch(body)).status, 400);
    assert.deepEqual(await (await first.request('/api/resources')).json(), before);
  }
  const savedResponse = await patch({ revision: 0, assignments });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.vehicles.find(vehicle => vehicle.id === 'G1').regionCode, 'Z002');
  assert.equal(saved.vehicles.find(vehicle => vehicle.id === 'G2').regionCode, 'Z001');
  assert.equal(saved.vehicles[0].id, 'G2');
  assert.equal(saved.vehicles[1].id, 'G1');
  assert.equal((await patch({ revision: 0, assignments: [{ id: 'G1', regionCode: null }] })).status, 409);
  assert.deepEqual(await (await first.request('/api/resources')).json(), saved);
  const together = await (await patch({ revision: 1, assignments: [
    { id: 'G1', regionCode: 'Z003' }, { id: 'G2', regionCode: 'Z003' },
  ] })).json();
  assert.equal(together.revision, 2);
  assert.equal(together.vehicles.find(vehicle => vehicle.id === 'G1').regionCode, 'Z003');
  assert.equal(together.vehicles.find(vehicle => vehicle.id === 'G2').regionCode, 'Z003');
  await first.demo.close();
  const second = await app(t, f.output);
  assert.deepEqual(await (await second.request('/api/resources')).json(), together);
});

test('v1 registry migrates transactionally to single region field preserving catalog and revision', async t => {
  const f = setup(t);
  v1Fixture(f.output);
  const { request } = await app(t, f.output);
  const snapshot = await (await request('/api/resources')).json();
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.vehicles.map(vehicle => [vehicle.id, vehicle.plate, vehicle.regionCode]),
    [['G1', '11가 1001', 'Z001'], ['G2', '12나 1002', 'Z002']]);
  assert.deepEqual(snapshot.regionCodes, [{ code: 'UNUSED' }, { code: 'Z001' }, { code: 'Z002' }]);
  assert.deepEqual(snapshot.source, { kind: 'legacy_vehicle_catalog', importedCount: 3, excludedCount: 1 });
  const db = new DatabaseSync(f.output, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vehicles').get().count, 3);
  assert.equal(db.prepare("SELECT fingerprint FROM source_catalog WHERE id=1").get().fingerprint, 'f'.repeat(64));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='categories'").get().count, 0);
  db.close();
});

test('v1 migration preserves all 155 vehicle IDs, plates, activity flags, and source counts', async t => {
  const f = setup(t);
  v1Fixture(f.output);
  const db = new DatabaseSync(f.output);
  const addCode = db.prepare('INSERT INTO categories VALUES (?)');
  const addVehicle = db.prepare('INSERT INTO vehicles VALUES (?,?,?,?,?)');
  for (let number = 3; number <= 155; number += 1) {
    const code = number <= 31 ? `Z${String(number).padStart(3, '0')}` : null;
    if (code) addCode.run(code);
    if (number === 3) db.prepare('UPDATE vehicles SET active=1, category_code=? WHERE id=?').run(code, 'G3');
    else addVehicle.run(`G${number}`, `${number}가 ${1000 + number}`, code, code ? 1 : 0, code);
  }
  db.prepare('UPDATE source_catalog SET imported_count=155, excluded_count=124 WHERE id=1').run();
  const before = db.prepare('SELECT id, plate, original_code AS originalCode, active, category_code AS regionCode FROM vehicles ORDER BY id').all();
  db.close();
  const { request } = await app(t, f.output);
  assert.equal((await request('/api/resources')).status, 200);
  const migrated = new DatabaseSync(f.output, { readOnly: true });
  assert.deepEqual(migrated.prepare('SELECT id, plate, original_code AS originalCode, active, region_code AS regionCode FROM vehicles ORDER BY id').all(), before);
  assert.deepEqual({ ...migrated.prepare('SELECT revision, imported_count AS importedCount, excluded_count AS excludedCount FROM source_catalog').get() },
    { revision: 7, importedCount: 155, excludedCount: 124 });
  migrated.close();
});

test('duplicate v1 region codes migrate, while invalid codes fail closed', async t => {
  const duplicate = setup(t);
  v1Fixture(duplicate.output, 'Z001');
  const migrated = await app(t, duplicate.output);
  const snapshot = await (await migrated.request('/api/resources')).json();
  assert.deepEqual(snapshot.vehicles.map(vehicle => vehicle.regionCode), ['Z001', 'Z001']);
  const invalid = setup(t);
  v1Fixture(invalid.output, '한글');
  const before = fs.readFileSync(invalid.output);
  const failed = await app(t, invalid.output);
  assert.equal((await failed.request('/api/resources')).status, 503);
  assert.deepEqual(fs.readFileSync(invalid.output), before);
  const db = new DatabaseSync(invalid.output, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='categories'").get().count, 1);
  db.close();
});

test('new import permits multiple active vehicles in one region', t => {
  const f = setup(t);
  fs.writeFileSync(f.input, JSON.stringify(day(['(Z001) 이름 1', '(z001) 이름 2'])));
  assert.equal(f.run().status, 0);
  const db = new DatabaseSync(f.output, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT region_code FROM vehicles ORDER BY id').all().map(row => row.region_code), ['Z001', 'Z001']);
  db.close();
});

test('different-source v1 output is rejected before migration or other writes', t => {
  const f = setup(t);
  v1Fixture(f.output);
  const before = fs.readFileSync(f.output);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(fs.readFileSync(f.output), before);
  const db = new DatabaseSync(f.output, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
});

test('v2 database constraints reject lowercase codes and allow shared regions', t => {
  const f = setup(t);
  assert.equal(f.run().status, 0);
  const db = new DatabaseSync(f.output);
  db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => db.prepare("UPDATE vehicles SET region_code='z001' WHERE id='G1'").run());
  assert.throws(() => db.prepare("UPDATE vehicles SET region_code='UNKNOWN' WHERE id='G1'").run());
  db.prepare("UPDATE vehicles SET region_code='Z001' WHERE id='G2'").run();
  assert.equal(db.prepare("SELECT region_code FROM vehicles WHERE id='G2'").get().region_code, 'Z001');
  db.close();
});
