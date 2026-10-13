import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { createDispatchOperations } from '../../lib/dispatch-operations.mjs';
import calculatorModule from '../../lib/dispatch-calculator.js';
import accessModule from '../../lib/access.js';

const { calculateDispatch } = calculatorModule;
const { createAccess } = accessModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = '127.0.0.1';
const existingUser = { username: 'node-vector', password: 'node-vector-1234', displayName: 'Node 벡터 사용자' };
const nativeUser = { username: 'native-user', password: 'native-user-1234', displayName: 'Kotlin 가입 사용자' };

function seoulDate(offset = 0) {
  const shifted = new Date(Date.now() + offset * 86_400_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function sourceSignature(manifest) {
  return createHash('sha256').update(JSON.stringify([
    manifest.source.csvSha256,
    null,
    manifest.dates.map(item => item.date).sort(),
  ])).digest('hex');
}

function syntheticDay(date) {
  const groups = [
    { id: 'TRUCK-1', label: '(Z001) 합성 기사 1', regionNames: ['합성 서부 권역'] },
    { id: 'TRUCK-2', label: '(Z002) 합성 기사 2', regionNames: ['합성 동부 권역'] },
  ];
  const orders = [
    { id: 'BUNDLE-1', orderNumber: 'STATE-1001', destinationId: 'dst_bundle', name: '합성 정육점 A', address: '검토 전용 가상주소 A', detailAddress: '가상 1층', boxes: 2, sequence: 1, coordinates: [126.81, 37.56], zoneIds: ['WEST'] },
    { id: 'BUNDLE-2', orderNumber: 'STATE-1002', destinationId: 'dst_bundle', name: '합성 정육점 A', address: '검토 전용 가상주소 A', detailAddress: '가상 1층', boxes: 3, sequence: 2, coordinates: [126.81, 37.56], zoneIds: ['WEST'] },
    { id: 'NEXT-1', orderNumber: 'STATE-1003', destinationId: 'dst_next_1', name: '합성 식당 B', address: '검토 전용 가상주소 B', detailAddress: '가상 2층', boxes: 4, sequence: 3, coordinates: [126.93, 37.51], zoneIds: ['EAST-1'] },
    { id: 'NEXT-2', orderNumber: 'STATE-1004', destinationId: 'dst_next_2', name: '합성 식당 C', address: '검토 전용 가상주소 C', detailAddress: '가상 3층', boxes: 5, sequence: 4, coordinates: [127.03, 37.49], zoneIds: ['EAST-2'] },
  ].map(order => ({
    ...order, groupId: 'TRUCK-1', sourceRows: 1, regionCode: 'Z001', regionName: '합성 권역',
  }));
  return {
    schemaVersion: 1,
    date,
    weekday: new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'long' }).format(new Date(`${date}T12:00:00+09:00`)),
    summary: { sourceRows: 4, boxes: 14, orders: 4, payments: 4, sites: 3, groups: 2, mappedOrders: 4, unmappedOrders: 0, uncoveredOrders: 0, multiZoneOrders: 0 },
    groups,
    orders,
  };
}

async function writeSource(directory) {
  const today = seoulDate();
  const tomorrow = seoulDate(1);
  const days = [syntheticDay(today), syntheticDay(tomorrow)];
  const source = { csvSha256: createHash('sha256').update(JSON.stringify({ fixture: 'kotlin-state-owner', days })).digest('hex'), synthetic: true };
  const manifest = {
    schemaVersion: 1,
    defaultDate: today,
    dates: days.map(({ date, weekday, summary }) => ({ date, weekday, summary })),
    source,
  };
  const destinations = {
    schemaVersion: 1,
    source: { ...source, manifestSignature: sourceSignature(manifest) },
    destinations: [],
  };
  const regions = { type: 'FeatureCollection', features: [] };
  await fs.mkdir(path.join(directory, 'days'), { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ['manifest.json', manifest], ['destinations.json', destinations], ['regions.geojson', regions],
    ...days.map(day => [`days/${day.date}.json`, day]),
  ]) {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(directory, name), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(directory, `${name}.gz`), gzipSync(bytes), { mode: 0o600 });
  }
  return { today, tomorrow, days, sourceId: source.csvSha256 };
}

async function bootJarPath() {
  const directory = path.join(root, 'services/api/build/libs');
  const jars = (await fs.readdir(directory)).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  assert.equal(jars.length, 1, 'build exactly one Kotlin bootJar before this actual-JAR test');
  return path.join(directory, jars[0]);
}

async function startKotlin(settings) {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const child = spawn(java, [
    // C1-only JIT: short-lived fixture JVMs spend ~40% less CPU on startup, so
    // the CPU-bound contract suite finishes sooner on 4-vCPU CI runners.
    '-Xms64m', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-jar', settings.jar,
    '--server.address=127.0.0.1', `--server.port=${settings.port}`,
    '--meatbox.compat.enabled=true', `--meatbox.compat.legacy-api-origin=http://${host}:${settings.legacyPort}`,
    `--meatbox.compat.dispatch-data-dir=${settings.dataDirectory}`,
    '--meatbox.resources.enabled=true', `--meatbox.resources.database=${settings.resourceDatabase}`,
    `--meatbox.resources.public-origin=${settings.publicOrigin}`,
    '--meatbox.auth.enabled=true', `--meatbox.auth.access-file=${settings.accessFile}`,
    `--meatbox.auth.public-origin=${settings.publicOrigin}`,
    '--meatbox.dispatch.enabled=true', `--meatbox.dispatch.state-dir=${settings.stateDirectory}`,
    `--meatbox.dispatch.public-origin=${settings.publicOrigin}`,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let startupError;
  const capture = chunk => { logs = (logs + chunk.toString()).slice(-32_768); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => { startupError = error; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const close = async () => {
    if (child.exitCode !== null || startupError) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  };
  const origin = `http://${host}:${settings.port}`;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Kotlin exited before readiness:\n${logs}`);
      try {
        const response = await fetch(`${origin}/actuator/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === 'UP' && logs.includes('Started MeatboxApiApplication')) {
          return { origin, close };
        }
      } catch { /* bounded readiness polling */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Kotlin readiness timed out:\n${logs}`);
  } catch (error) {
    await close();
    throw error;
  }
}

async function createFixture() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-kotlin-state-owner-')));
  await fs.chmod(temporary, 0o700);
  const dataDirectory = path.join(temporary, 'dispatch-data');
  const stateDirectory = path.join(temporary, 'dispatch-state');
  const accessFile = path.join(temporary, 'access.json');
  const resourceDatabase = path.join(temporary, 'resources/resources.sqlite');
  const source = await writeSource(dataDirectory);
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const imported = spawnSync(process.execPath, [path.join(root, 'scripts/import-resource-catalog.mjs'), '--day', path.join(dataDirectory, 'days', `${source.today}.json`), '--output', resourceDatabase], { cwd: root, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr || imported.error?.message);

  const fixedNow = Date.now();
  const access = createAccess({ file: accessFile, now: () => fixedNow });
  const existingInvite = await access.issueInvite();
  await access.register({ ...existingUser, invite: existingInvite });
  const nativeInvite = await access.issueInvite();
  const [port, legacyPort, publicPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const settings = {
    jar: await bootJarPath(), port, legacyPort, publicOrigin: `http://${host}:${publicPort}`,
    dataDirectory, stateDirectory, accessFile, resourceDatabase,
  };
  let kotlin = await startKotlin(settings);
  let closed = false;
  return {
    ...source, ...settings, fixedNow, access, nativeInvite,
    get origin() { return kotlin.origin; },
    async restart() { await kotlin.close(); kotlin = await startKotlin(settings); },
    async close() {
      if (closed) return;
      closed = true;
      await kotlin.close();
      await fs.rm(temporary, { recursive: true, force: true });
    },
  };
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  assert.match(header ?? '', /^meatbox_session=[A-Za-z0-9_-]{32,};/);
  return header.split(';', 1)[0];
}

async function postForm(fixture, pathname, fields, cookie) {
  return fetch(`${fixture.origin}${pathname}`, {
    method: 'POST', redirect: 'manual',
    headers: {
      Origin: fixture.publicOrigin,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

async function login(fixture, user = existingUser) {
  const response = await postForm(fixture, '/login', { username: user.username, password: user.password, next: '/combined/' });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function requestJson(fixture, pathname, { cookie, method = 'GET', body, origin = fixture.publicOrigin, headers = {} } = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const dynamicKeys = new Set(['boot', 'simTime', 'simClock', 'time', 'ts', 'stateTimestamp']);
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !dynamicKeys.has(key))
    .map(([key, entry]) => [key, normalized(entry)]));
}

function demoFreeGolden(engine) {
  const checkpoint = structuredClone(engine.exportCheckpoint());
  if (checkpoint.confirmedEngineCheckpoint) checkpoint.confirmedEngineCheckpoint.presentationContentVersion = 0;
  return checkpoint;
}

function commandFor(actualState, type, extra = {}) {
  return { type, expectedBoot: actualState.boot, expectedRevision: actualState.revision, ...extra };
}

test('Kotlin owns native authentication and durable dispatch state', { timeout: 180_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());

  await t.test('protects native source, resource, and dispatch reads before login', async () => {
    for (const [pathname, marker] of [
      ['/api/dispatch-data/manifest', ['x-meatbox-source-reader', 'kotlin']],
      ['/api/resources', ['x-meatbox-resource-owner', 'kotlin']],
      [`/api/dispatch-data/days/${fixture.today}/state`, ['x-meatbox-dispatch-owner', 'kotlin']],
    ]) {
      const { response, body } = await requestJson(fixture, pathname);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get(marker[0]), marker[1]);
      assert.equal(body.error, 'LOGIN_REQUIRED');
    }
  });

  await t.test('rejects path parameter spellings before the session check', async () => {
    for (const pathname of [
      '/api/dispatch-data/manifest;x=1',
      '/api/dispatch-data/regions;x=1',
      '/api/resources;x=1',
      `/api/dispatch-data/days/${fixture.today}/state;x=1`,
    ]) {
      const { response, body } = await requestJson(fixture, pathname);
      assert.equal(response.status, 400, pathname);
      assert.equal(body.error, 'INVALID_PATH', pathname);
    }
  });

  await t.test('rejects cross-origin and invalid native authentication requests', async () => {
    const forbidden = await fetch(`${fixture.origin}/login`, {
      method: 'POST', headers: { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: existingUser.username, password: existingUser.password }),
    });
    assert.equal(forbidden.status, 403);
    const invalid = await postForm(fixture, '/login', { username: existingUser.username, password: 'wrong-password' });
    assert.equal(invalid.status, 401);
    assert.doesNotMatch(await invalid.text(), /node-vector-1234|scrypt\$/);
  });

  await t.test('registers a native account into the shared scrypt access file once', async () => {
    const registered = await postForm(fixture, '/dev/register', { ...nativeUser, invite: fixture.nativeInvite });
    assert.equal(registered.status, 303);
    assert.equal(registered.headers.get('location'), '/login?registered=1');
    const reused = await postForm(fixture, '/dev/register', { ...nativeUser, username: 'another-user', invite: fixture.nativeInvite });
    assert.equal(reused.status, 400);
    const stored = JSON.parse(await fs.readFile(fixture.accessFile, 'utf8'));
    assert.match(stored.users[nativeUser.username].passwordHash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(JSON.stringify(stored).includes(nativeUser.password), false);
    assert.equal(JSON.stringify(stored).includes(fixture.nativeInvite), false);
  });

  let cookie;
  await t.test('accepts a Node-created scrypt account and serves all native read owners', async () => {
    cookie = await login(fixture);
    const session = await requestJson(fixture, '/api/session', { cookie });
    assert.equal(session.response.status, 200);
    assert.equal(session.body.user.username, existingUser.username);
    for (const [pathname, marker] of [
      ['/api/dispatch-data/manifest', ['x-meatbox-source-reader', 'kotlin']],
      ['/api/resources', ['x-meatbox-resource-owner', 'kotlin']],
      [`/api/dispatch-data/days/${fixture.today}/state`, ['x-meatbox-dispatch-owner', 'kotlin']],
    ]) {
      const result = await requestJson(fixture, pathname, { cookie });
      assert.equal(result.response.status, 200);
      assert.equal(result.response.headers.get(marker[0]), marker[1]);
    }
  });

  await t.test('logs in a Kotlin-created account and revokes its active session from the shared file', async () => {
    const nativeCookie = await login(fixture, nativeUser);
    assert.equal((await requestJson(fixture, '/api/session', { cookie: nativeCookie })).response.status, 200);
    await createAccess({ file: fixture.accessFile }).disableUser(nativeUser.username);
    assert.equal((await requestJson(fixture, '/api/session', { cookie: nativeCookie })).response.status, 401);
  });

  await t.test('rejects invalid command envelopes without changing state', async () => {
    const before = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    const missing = await requestJson(fixture, '/api/dispatch-data/days/2099-12-31/state', { cookie });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'DISPATCH_DATA_NOT_FOUND');
    const cases = [
      [{ method: 'POST', cookie, body: '{"type":"calculate_dispatch","type":"reassign"}' }, 400, 'INVALID_COMMAND'],
      [{ method: 'POST', cookie, body: '{' }, 400, 'INVALID_COMMAND'],
      [{ method: 'POST', cookie, body: commandFor(before, 'calculate_dispatch', { vehicleIds: ['TRUCK-1'] }), origin: 'http://127.0.0.1:1' }, 403, 'ORIGIN_REQUIRED'],
      [{ method: 'POST', cookie, body: { ...commandFor(before, 'calculate_dispatch', { vehicleIds: ['TRUCK-1'] }), expectedBoot: 'stale-boot' } }, 409, 'BOOT_MISMATCH'],
    ];
    for (const [options, status, code] of cases) {
      const result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, options);
      assert.equal(result.response.status, status);
      assert.equal(result.body.error, code);
    }
    for (const type of ['set_scenario', 'arrive_stop', 'complete_stop', 'toggle_skip', 'set_delivery_tip', 'send_customer_notice', 'reset']) {
      const result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, {
        method: 'POST', cookie, body: commandFor(before, type),
      });
      assert.equal(result.response.status, 400, type);
      assert.equal(result.body.error, 'INVALID_COMMAND', type);
    }
    const tooLarge = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, {
      method: 'POST', cookie, body: JSON.stringify({ type: 'set_scenario', padding: 'x'.repeat(128 * 1024) }),
    });
    assert.equal(tooLarge.response.status, 413);
    assert.equal(tooLarge.body.error, 'COMMAND_TOO_LARGE');
    const after = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    assert.equal(after.revision, before.revision);
  });

  const day = fixture.days.find(value => value.date === fixture.today);
  let golden = createDispatchOperations(day, {
    sourceId: fixture.sourceId,
    operatingDate: fixture.today,
    now: () => fixture.fixedNow,
    calculator: calculateDispatch,
  });
  let actualState = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;

  async function compareCommand(type, extra = {}, expectedGoldenState) {
    const expected = golden.command({ type, expectedRevision: golden.revision, ...extra });
    const actual = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, {
      method: 'POST', cookie, body: commandFor(actualState, type, extra),
    });
    assert.equal(actual.response.status, 200, JSON.stringify(actual.body));
    actualState = actual.body.state;
    assert.deepEqual(normalized(actual.body.result), normalized(expected.result));
    assert.deepEqual(normalized(actual.body.state), normalized(expectedGoldenState?.() ?? expected.state));
    return actual.body;
  }

  await t.test('matches the Node golden calculation and persists the candidate across restart', async () => {
    await compareCommand('calculate_dispatch', { vehicleIds: ['TRUCK-1', 'TRUCK-2'] });
    const beforeRestart = normalized(actualState);
    const previousBoot = actualState.boot;
    const oldCookie = cookie;
    await fixture.restart();
    assert.equal((await requestJson(fixture, '/api/session', { cookie: oldCookie })).response.status, 401);
    cookie = await login(fixture);
    actualState = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    assert.notEqual(actualState.boot, previousBoot);
    assert.deepEqual(normalized(actualState), beforeRestart);
  });

  let targetVehicleId;
  await t.test('matches the Node golden bundled-destination reassignment', async () => {
    const bundleUnit = golden.snapshot().dispatchOrders.find(order => order.id === 'BUNDLE-1').assignmentUnitId;
    const bundle = golden.snapshot().dispatchOrders.filter(order => order.assignmentUnitId === bundleUnit);
    assert.equal(bundle.length, 2);
    targetVehicleId = ['TRUCK-1', 'TRUCK-2'].find(id => id !== bundle[0].vehicleId);
    await compareCommand('reassign', { targetVehicleId, orderIds: [bundle[0].id] });
    const moved = actualState.dispatchOrders.filter(order => order.assignmentUnitId === bundleUnit);
    assert.deepEqual(new Set(moved.map(order => order.vehicleId)), new Set([targetVehicleId]));
  });

  await t.test('matches the Node golden publish while omitting synthetic presentation content', async () => {
    const expectedResult = golden.command({ type: 'publish_dispatch', expectedRevision: golden.revision, draftVersion: golden.snapshot().dispatch.draftVersion });
    const checkpoint = demoFreeGolden(golden);
    golden = createDispatchOperations(day, {
      sourceId: fixture.sourceId, operatingDate: fixture.today, now: () => fixture.fixedNow,
      calculator: calculateDispatch, checkpoint,
    });
    const actual = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, {
      method: 'POST', cookie,
      body: commandFor(actualState, 'publish_dispatch', { draftVersion: actualState.dispatch.draftVersion }),
    });
    assert.equal(actual.response.status, 200, JSON.stringify(actual.body));
    actualState = actual.body.state;
    assert.deepEqual(normalized(actual.body.result), normalized(expectedResult.result));
    assert.deepEqual(normalized(actual.body.state), normalized(golden.snapshot()));
    assert.equal(actualState.fleetDeliveries.every(order => order.tip === null && order.items.length === 0), true);
  });

  await t.test('matches the Node golden route-order command and rejects stale revision atomically', async () => {
    const route = actualState.fleetDeliveries.filter(order => order.vehicleId === targetVehicleId);
    assert.ok(route.length >= 2);
    const groups = [];
    for (const item of route) {
      const previous = groups.at(-1);
      if (previous?.unit === item.assignmentUnitId) previous.ids.push(item.id);
      else groups.push({ unit: item.assignmentUnitId, ids: [item.id] });
    }
    assert.ok(groups.length >= 2);
    const order = groups.reverse().flatMap(group => group.ids);
    const vehicle = actualState.vehicleStates[targetVehicleId];
    const extra = { vehicleId: targetVehicleId, order, expectedOrder: route.map(item => item.id), expectedStatuses: route.map(item => item.status), expectedPhase: vehicle.phase };
    await compareCommand('set_route_order', extra);
    const revision = actualState.revision;
    const stale = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, {
      method: 'POST', cookie,
      body: { ...commandFor(actualState, 'begin_dispatch_revision'), expectedRevision: revision - 1 },
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error, 'REVISION_CONFLICT');
    assert.equal((await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body.revision, revision);
  });

  await t.test('matches the Node golden begin and discard revision commands', async () => {
    await compareCommand('begin_dispatch_revision');
    assert.equal(actualState.dispatch.phase, 'amending');
    await compareCommand('discard_dispatch_revision');
    assert.equal(actualState.dispatch.phase, 'published');
  });

  await t.test('serves ETag revalidation and restores the final checkpoint after restart', async () => {
    const first = await fetch(`${fixture.origin}/api/dispatch-data/days/${fixture.today}/state`, { headers: { Cookie: cookie } });
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    const cached = await fetch(`${fixture.origin}/api/dispatch-data/days/${fixture.today}/state`, { headers: { Cookie: cookie, 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    const expected = normalized(actualState);
    await fixture.restart();
    cookie = await login(fixture);
    actualState = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    assert.deepEqual(normalized(actualState), expected);
    const checkpoint = JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, `${fixture.today}.json`), 'utf8'));
    assert.deepEqual(normalized(checkpoint), normalized(demoFreeGolden(golden)));
  });

  await t.test('rejects a checkpoint symlink without mutating the future-date state', async () => {
    const target = path.join(fixture.stateDirectory, 'outside.json');
    const checkpoint = path.join(fixture.stateDirectory, `${fixture.tomorrow}.json`);
    const state = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie })).body;
    await fs.writeFile(target, '{"untouched":true}\n', { mode: 0o600 });
    await fs.symlink(target, checkpoint);
    const result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/commands`, {
      method: 'POST', cookie, body: commandFor(state, 'calculate_dispatch', { vehicleIds: ['TRUCK-1', 'TRUCK-2'] }),
    });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, 'DISPATCH_STATE_WRITE_FAILED');
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).untouched, true);
    assert.equal((await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie })).body.revision, 0);
    await fs.unlink(checkpoint);
  });

  let futureCheckpoint;
  await t.test('persists a valid future-date candidate after a failed symlink write', async () => {
    let state = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie })).body;
    const result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/commands`, {
      method: 'POST', cookie, body: commandFor(state, 'calculate_dispatch', { vehicleIds: ['TRUCK-1', 'TRUCK-2'] }),
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    futureCheckpoint = await fs.readFile(path.join(fixture.stateDirectory, `${fixture.tomorrow}.json`));
  });

  await t.test('rejects corrupt and source-mismatched checkpoints and recovers from the saved candidate', async () => {
    const checkpointPath = path.join(fixture.stateDirectory, `${fixture.tomorrow}.json`);
    await fixture.restart();
    await fs.writeFile(checkpointPath, '{', { mode: 0o600 });
    await fixture.restart();
    cookie = await login(fixture);
    let result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, 'DISPATCH_STATE_INVALID');

    const mismatched = JSON.parse(futureCheckpoint.toString());
    mismatched.sourceId = '0'.repeat(64);
    await fs.writeFile(checkpointPath, JSON.stringify(mismatched), { mode: 0o600 });
    await fixture.restart();
    cookie = await login(fixture);
    result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, 'DISPATCH_STATE_SOURCE_MISMATCH');

    await fs.writeFile(checkpointPath, futureCheckpoint, { mode: 0o600 });
    await fixture.restart();
    cookie = await login(fixture);
    result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/state`, { cookie });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.dispatch.phase, 'draft');
    assert.equal(result.body.revision, 1);
  });

  await t.test('logout revokes the final native session', async () => {
    const logout = await postForm(fixture, '/logout', {}, cookie);
    assert.equal(logout.status, 303);
    assert.equal((await requestJson(fixture, '/api/session', { cookie })).response.status, 401);
  });
});

test('Kotlin rejects mismatched source dates before serving or saving dispatch state', { timeout: 90_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const sourcePath = date => path.join(fixture.dataDirectory, 'days', `${date}.json`);
  const route = date => `/api/dispatch-data/days/${date}`;
  const validDay = { ...fixture.days[0], vendorMetadata: { keep: 'unknown source field' } };
  const plain = Buffer.from(` ${JSON.stringify(validDay)}\n`);
  const compressed = gzipSync(plain);
  await fs.writeFile(sourcePath(fixture.today), plain);
  await fs.writeFile(`${sourcePath(fixture.today)}.gz`, compressed);

  const rawRead = (pathname, encoding) => new Promise((resolve, reject) => {
    const request = http.get(new URL(pathname, fixture.origin), {
      headers: { Cookie: cookie, 'Accept-Encoding': encoding },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Source date boundary request timed out')));
    request.on('error', reject);
  });

  await t.test('keeps normal raw and gzip bytes unknown fields and representation etags', async () => {
    for (const [encoding, expected] of [['identity', plain], ['gzip', compressed]]) {
      const response = await rawRead(route(fixture.today), encoding);
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, expected);
      assert.equal(response.headers.etag, `"${createHash('sha256').update(expected).digest('hex')}"`);
      assert.equal(response.headers['content-encoding'], encoding === 'gzip' ? 'gzip' : undefined);
    }
  });

  // Today is warm; tomorrow has not been read by DispatchStore.
  const initial = (await requestJson(fixture, `${route(fixture.today)}/state`, { cookie })).body;
  await t.test('rejects wrong and missing raw dates for cold and warm plans without a checkpoint', async () => {
    for (const date of [fixture.tomorrow, fixture.today]) {
      const original = await fs.readFile(sourcePath(date));
      const day = JSON.parse(original);
      for (const invalid of [{ ...day, date: date === fixture.today ? fixture.tomorrow : fixture.today },
        Object.fromEntries(Object.entries(day).filter(([key]) => key !== 'date'))]) {
        try {
          await fs.writeFile(sourcePath(date), JSON.stringify(invalid));
          for (const encoding of ['identity', 'gzip']) {
            const response = await rawRead(route(date), encoding);
            assert.equal(response.status, 500);
            assert.deepEqual(JSON.parse(response.bytes), { error: 'DISPATCH_DATA_INVALID' });
          }
          const state = await requestJson(fixture, `${route(date)}/state`, { cookie });
          assert.equal(state.response.status, 500);
          assert.equal(state.body.error, 'DISPATCH_DATA_INVALID');
          const command = await requestJson(fixture, `${route(date)}/commands`, {
            cookie, method: 'POST', body: commandFor(initial, 'calculate_dispatch', { vehicleIds: ['TRUCK-1'] }),
          });
          assert.equal(command.response.status, 500);
          assert.equal(command.body.error, 'DISPATCH_DATA_INVALID');
          assert.deepEqual(await fs.readdir(fixture.stateDirectory), []);
        } finally { await fs.writeFile(sourcePath(date), original); }
        const restored = await requestJson(fixture, `${route(date)}/state`, { cookie });
        assert.equal(restored.response.status, 200);
        assert.equal(restored.body.sourceData.date, date);
        assert.equal(restored.body.revision, 0);
      }
    }
  });

  await t.test('checks the selected gzip date rather than trusting its valid raw sibling', async () => {
    for (const invalid of [{ ...validDay, date: fixture.tomorrow },
      Object.fromEntries(Object.entries(validDay).filter(([key]) => key !== 'date'))]) {
      try {
        await fs.writeFile(`${sourcePath(fixture.today)}.gz`, gzipSync(Buffer.from(JSON.stringify(invalid))));
        assert.equal((await rawRead(route(fixture.today), 'identity')).status, 200);
        const response = await rawRead(route(fixture.today), 'gzip');
        assert.equal(response.status, 500);
        assert.deepEqual(JSON.parse(response.bytes), { error: 'DISPATCH_DATA_INVALID' });
        assert.deepEqual(await fs.readdir(fixture.stateDirectory), []);
      } finally { await fs.writeFile(`${sourcePath(fixture.today)}.gz`, compressed); }
    }
  });

  await t.test('rejects gzip expansion above the dispatch day limit with a valid date and raw sibling', async () => {
    const excessive = Buffer.alloc(16 * 1024 * 1024 + 1, ' ');
    plain.copy(excessive);
    try {
      await fs.writeFile(`${sourcePath(fixture.today)}.gz`, gzipSync(excessive));
      const response = await rawRead(route(fixture.today), 'gzip');
      assert.equal(response.status, 500);
      assert.deepEqual(JSON.parse(response.bytes), { error: 'DISPATCH_DATA_INVALID' });
      assert.deepEqual((await rawRead(route(fixture.today), 'identity')).bytes, plain);
      assert.deepEqual(await fs.readdir(fixture.stateDirectory), []);
    } finally { await fs.writeFile(`${sourcePath(fixture.today)}.gz`, compressed); }
  });

  await t.test('rejects an oversized raw day before serving cached state or saving a checkpoint', async () => {
    const excessive = Buffer.alloc(16 * 1024 * 1024 + 1, ' ');
    plain.copy(excessive);
    try {
      await fs.writeFile(sourcePath(fixture.today), excessive);
      for (const encoding of ['identity', 'gzip']) {
        const response = await rawRead(route(fixture.today), encoding);
        assert.equal(response.status, 500);
        assert.deepEqual(JSON.parse(response.bytes), { error: 'DISPATCH_DATA_INVALID' });
      }
      const state = await requestJson(fixture, `${route(fixture.today)}/state`, { cookie });
      assert.equal(state.response.status, 500);
      assert.equal(state.body.error, 'DISPATCH_DATA_INVALID');
      const command = await requestJson(fixture, `${route(fixture.today)}/commands`, {
        cookie, method: 'POST', body: commandFor(initial, 'calculate_dispatch', { vehicleIds: ['TRUCK-1'] }),
      });
      assert.equal(command.response.status, 500);
      assert.equal(command.body.error, 'DISPATCH_DATA_INVALID');
      assert.deepEqual(await fs.readdir(fixture.stateDirectory), []);
    } finally { await fs.writeFile(sourcePath(fixture.today), plain); }
  });

  await t.test('allows the unchanged source to create a valid checkpoint after rejection', async () => {
    const response = await requestJson(fixture, `${route(fixture.today)}/commands`, {
      cookie, method: 'POST', body: commandFor(initial, 'calculate_dispatch', { vehicleIds: ['TRUCK-1'] }),
    });
    assert.equal(response.response.status, 200);
    const saved = JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, `${fixture.today}.json`), 'utf8'));
    assert.equal(saved.date, fixture.today);
    assert.equal(saved.revision, 1);
  });
});
