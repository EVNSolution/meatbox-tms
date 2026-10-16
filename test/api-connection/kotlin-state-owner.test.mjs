import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { assertProblem } from './problem.mjs';

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
    ...(settings.depot ? [`--meatbox.route.depot-lat=${settings.depot[0]}`, `--meatbox.route.depot-lng=${settings.depot[1]}`] : []),
    ...(settings.outbound ? [
      '--meatbox.mock-receiver.enabled=true', '--meatbox.outbound.interval-seconds=1',
      `--meatbox.outbound.base-url=http://${host}:${settings.port}/mock/meatbox`,
    ] : []),
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

async function createFixture({ outbound = false, depot = null } = {}) {
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
    dataDirectory, stateDirectory, accessFile, resourceDatabase, outbound, depot,
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
    for (const type of ['set_scenario', 'toggle_skip', 'set_delivery_tip', 'send_customer_notice', 'reset']) {
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
    const loggedOutCookie = await login(fixture);
    assert.equal((await postForm(fixture, '/logout', {}, loggedOutCookie)).status, 303);
    await fixture.restart();
    // Sessions persist across a restart or blue/green switch; a logged-out session stays dead.
    assert.equal((await requestJson(fixture, '/api/session', { cookie })).response.status, 200);
    assert.equal((await requestJson(fixture, '/api/session', { cookie: loggedOutCookie })).response.status, 401);
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
    // `outbox` holds the Meatbox messages that publishing owes. Node has no outbound sender, so the golden has none.
    assert.equal(checkpoint.outbox.length, 4);
    delete checkpoint.outbox;
    // `contentHash` binds the checkpoint to its day file's bytes; Node's golden has no such field.
    assert.match(checkpoint.contentHash, /^[0-9a-f]{64}$/);
    delete checkpoint.contentHash;
    assert.deepEqual(normalized(checkpoint), normalized(demoFreeGolden(golden)));
  });

  await t.test('returns the first result for a resent requestId, also after restart, and serves it by GET', async () => {
    const commands = `/api/dispatch-data/days/${fixture.today}/commands`;
    const body = { ...commandFor(actualState, 'begin_dispatch_revision'), requestId: 'a0b1c2d3-0000-4000-8000-000000000001' };
    const first = await requestJson(fixture, commands, { method: 'POST', cookie, body });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    const resent = await requestJson(fixture, commands, { method: 'POST', cookie, body });
    assert.deepEqual(resent.body, first.body);
    const changed = await requestJson(fixture, commands, { method: 'POST', cookie, body: { ...body, expectedRevision: 0 } });
    assert.equal(changed.response.status, 409);
    assert.equal(changed.body.error, 'REQUEST_ID_MISMATCH');
    await fixture.restart();
    cookie = await login(fixture);
    const afterRestart = await requestJson(fixture, commands, { method: 'POST', cookie, body });
    assert.deepEqual(afterRestart.body, first.body);
    const fetched = await requestJson(fixture, `${commands}/${body.requestId}`, { cookie });
    assert.equal(fetched.response.status, 200);
    assert.deepEqual(fetched.body, first.body);
    const state = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    assert.equal(state.revision, first.body.state.revision);
    const missing = await requestJson(fixture, `${commands}/unknown-id`, { cookie });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'REQUEST_NOT_FOUND');
    assert.equal((await requestJson(fixture, `${commands}/${body.requestId}`)).response.status, 401);
    // Keep the shared golden flow in step for the tests that follow.
    golden.command({ type: 'begin_dispatch_revision', expectedRevision: golden.revision });
    actualState = state;
    await compareCommand('discard_dispatch_revision');
  });

  await t.test('executes driver bundles with conflict guards atomic saves and arrival restoration', async () => {
    const statePath = `/api/dispatch-data/days/${fixture.today}/state`;
    const commandPath = `/api/dispatch-data/days/${fixture.today}/commands`;
    const vehicleId = targetVehicleId;
    const route = () => actualState.fleetDeliveries.filter(order => order.vehicleId === vehicleId);
    async function send(type, extra = {}) {
      const response = await requestJson(fixture, commandPath, {
        method: 'POST', cookie, body: commandFor(actualState, type, { vehicleId, ...extra }),
      });
      assert.equal(response.response.status, 200, JSON.stringify(response.body));
      actualState = response.body.state;
      return response.body.result;
    }
    async function rejects(type, extra, status, code) {
      const before = actualState;
      const response = await requestJson(fixture, commandPath, {
        method: 'POST', cookie, body: commandFor(actualState, type, { vehicleId, ...extra }),
      });
      assert.equal(response.response.status, status, JSON.stringify(response.body));
      if (code) assert.equal(response.body.error, code);
      assert.deepEqual((await requestJson(fixture, statePath, { cookie })).body, before);
    }

    // Start with the two-order destination to exercise canonical stop IDs through the HTTP boundary.
    const bundle = route().filter(order => order.id.startsWith('BUNDLE-'));
    assert.equal(bundle.length, 2);
    const bundleFirst = [...bundle, ...route().filter(order => !bundle.includes(order))].map(order => order.id);
    if (bundleFirst.some((id, index) => id !== route()[index].id)) {
      await send('set_route_order', {
        order: bundleFirst, expectedOrder: route().map(order => order.id),
        expectedStatuses: route().map(order => order.status), expectedPhase: 'idle',
      });
    }
    await rejects('start_route', { expectedBoot: 'stale-driver-boot' }, 409, 'BOOT_MISMATCH');
    await rejects('start_route', { expectedRevision: actualState.revision - 1 }, 409, 'REVISION_CONFLICT');
    await rejects('start_route', { vehicleId: 'UNKNOWN' }, 400, 'INVALID_OPERATION');
    const started = await send('start_route');
    assert.deepEqual(started.orderIds, bundle.map(order => order.id));
    assert.equal(actualState.vehicleStates[vehicleId].phase, 'delivering');
    assert.equal(actualState.vehicleStates[vehicleId].truck.toId, bundle[0].id);
    await rejects('start_route', {}, 409);
    await rejects('complete_stop', { orderId: bundle[0].id }, 409);
    await rejects('arrive_stop', { orderId: route().find(order => order.status === 'pending').id }, 409);
    await rejects('arrive_stop', { orderId: bundle[0].id, vehicleId: ['TRUCK-1', 'TRUCK-2'].find(id => id !== vehicleId) }, 400);

    const arrived = await send('arrive_stop', { orderId: bundle[1].id });
    assert.equal(arrived.stopId, bundle[0].id);
    assert.deepEqual(arrived.orderIds, bundle.map(order => order.id));
    for (const order of route().filter(order => arrived.orderIds.includes(order.id))) {
      assert.equal(order.status, 'current');
      assert.equal(order.customerStatus.key, 'arrived');
      assert.match(order.arrivedAt, /^\d{2}:\d{2}$/);
    }
    assert.equal(actualState.vehicleStates[vehicleId].truck.toId, null);
    assert.equal(actualState.vehicleStates[vehicleId].truck.atStopId, bundle[0].id);
    await rejects('arrive_stop', { orderId: bundle[1].id }, 409);

    const checkpoint = path.join(fixture.stateDirectory, `${fixture.today}.json`);
    const saved = `${checkpoint}.saved`;
    const outside = path.join(fixture.stateDirectory, 'driver-save-sentinel.json');
    await fs.writeFile(outside, '{"untouched":true}\n', { mode: 0o600 });
    await fs.rename(checkpoint, saved);
    try {
      await fs.symlink(outside, checkpoint);
      await rejects('complete_stop', { orderId: bundle[1].id }, 500, 'DISPATCH_STATE_WRITE_FAILED');
      assert.deepEqual(JSON.parse(await fs.readFile(outside, 'utf8')), { untouched: true });
    } finally {
      await fs.rm(checkpoint, { force: true });
      await fs.rename(saved, checkpoint);
    }
    const beforeRestart = actualState;
    await fixture.restart();
    actualState = (await requestJson(fixture, statePath, { cookie })).body;
    assert.notEqual(actualState.boot, beforeRestart.boot);
    assert.deepEqual(normalized(actualState), normalized(beforeRestart));
    await rejects('complete_stop', { orderId: bundle[1].id, expectedBoot: beforeRestart.boot }, 409, 'BOOT_MISMATCH');

    const completed = await send('complete_stop', { orderId: bundle[1].id });
    assert.deepEqual(completed.orderIds, bundle.map(order => order.id));
    assert.equal(actualState.vehicleStates[vehicleId].kpi.stopsDone, 2);
    assert.equal(actualState.vehicleStates[vehicleId].truck.toId, completed.nextStopId);
    for (const order of route().filter(order => completed.orderIds.includes(order.id))) {
      assert.equal(order.status, 'done');
      assert.equal(order.customerStatus.key, 'delivered');
      assert.match(order.completedAt, /^\d{2}:\d{2}$/);
    }
    await rejects('complete_stop', { orderId: bundle[0].id }, 409);
    await rejects('arrive_stop', { orderId: bundle[0].id }, 409);
    await rejects('set_route_order', {
      order: [...route().filter(order => !completed.orderIds.includes(order.id)), ...route().filter(order => completed.orderIds.includes(order.id))].map(order => order.id),
      expectedOrder: route().map(order => order.id), expectedStatuses: route().map(order => order.status), expectedPhase: 'delivering',
    }, 400);

    for (let current = route().find(order => order.status === 'current'); current; current = route().find(order => order.status === 'current')) {
      await send('arrive_stop', { orderId: current.id });
      await send('complete_stop', { orderId: current.id });
    }
    assert.equal(route().every(order => order.status === 'done'), true);
    assert.equal(actualState.vehicleStates[vehicleId].phase, 'done');
    assert.equal(actualState.vehicleStates[vehicleId].truck.toId, null);
    assert.equal(actualState.vehicleStates[vehicleId].truck.dwelling, false);
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

  await t.test('rejects corrupt checkpoints, shows a source conflict and recovers from the saved candidate', async () => {
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
    assert.equal(result.response.status, 200);
    assert.equal(result.body.dispatch, null);
    assert.equal(result.body.sourceConflict.reason, 'source');
    assert.equal(result.body.sourceConflict.expectedSourceId, '0'.repeat(64));
    assert.equal(result.body.sourceConflict.checkpointPhase, 'draft');
    const { boot } = result.body;
    result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.tomorrow}/commands`, {
      method: 'POST', cookie, body: { type: 'calculate_dispatch', expectedBoot: boot, expectedRevision: 1, vehicleIds: ['TRUCK-1'] },
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, 'SOURCE_CHANGED');

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
            assertProblem(response, JSON.parse(response.bytes), 500, 'DISPATCH_DATA_INVALID');
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
        assertProblem(response, JSON.parse(response.bytes), 500, 'DISPATCH_DATA_INVALID');
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
      assertProblem(response, JSON.parse(response.bytes), 500, 'DISPATCH_DATA_INVALID');
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
        assertProblem(response, JSON.parse(response.bytes), 500, 'DISPATCH_DATA_INVALID');
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

test('Kotlin driver endpoints take a photo, translate an event once and list the history', { timeout: 90_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  const driver = `${days}/driver`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const event = (eventId, type, payload) => ({
    eventId, type, payload, occurredAt: '2026-11-02T10:41:00+09:00', date: fixture.today, vehicleId: 'TRUCK-1',
  });
  const problem = ({ response, body }, status, code) => {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
    assert.equal(body.code, code);
  };
  const post = (pathname, body) => requestJson(fixture, `${driver}${pathname}`, { method: 'POST', cookie, body });

  const departed = await post('/events', event('depart-1', 'departed', {}));
  assert.equal(departed.response.status, 202, JSON.stringify(departed.body));
  const route = (await requestJson(fixture, `${driver}/route?vehicleId=TRUCK-1`, { cookie })).body;
  assert.equal(route.phase, 'delivering');
  const first = route.stops[0];
  assert.equal(first.status, 'current');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
  const form = new FormData();
  form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'proof.jpg');
  const upload = await fetch(`${fixture.origin}${driver}/photos`, {
    method: 'POST', headers: { Cookie: cookie, Origin: fixture.publicOrigin }, body: form,
  });
  assert.equal(upload.status, 201);
  const photo = await upload.json();
  assert.equal(photo.bytes, jpeg.length);
  const download = await fetch(`${fixture.origin}${driver}/photos/${photo.photoId}`, { headers: { Cookie: cookie } });
  assert.equal(download.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), jpeg);

  const completed = event('complete-1', 'stop_completed', { stopId: first.stopId, photoIds: [photo.photoId], note: '문 앞' });
  const accepted = await post('/events', completed);
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.duplicate, false);
  assert.equal(accepted.body.stop.status, 'done');
  const revision = (await requestJson(fixture, `${days}/state`, { cookie })).body.revision;
  const resent = await post('/events', completed);
  assert.equal(resent.response.status, 202);
  assert.deepEqual({ ...resent.body, duplicate: false }, accepted.body);
  assert.equal(resent.body.duplicate, true);
  assert.equal((await requestJson(fixture, `${days}/state`, { cookie })).body.revision, revision);

  const changed = await post('/events', { ...completed, payload: { ...completed.payload, note: '다른 본문' } });
  problem(changed, 409, 'REQUEST_ID_MISMATCH');
  const missing = await post('/events', event('complete-2', 'stop_completed', { stopId: route.stops[1].stopId, photoIds: ['00000000-0000-4000-8000-000000000000'] }));
  problem(missing, 400, 'PHOTO_NOT_FOUND');
  await fixture.restart();
  const looked = await requestJson(fixture, `${driver}/events/complete-1`, { cookie });
  assert.equal(looked.response.status, 200);
  assert.deepEqual(looked.body, resent.body);

  const history = (await requestJson(fixture, `${driver}/history?vehicleId=TRUCK-1`, { cookie })).body;
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].stopId, first.stopId);
  assert.equal(history.items[0].result, 'completed');
  assert.deepEqual(history.items[0].photoIds, [photo.photoId]);
  assert.equal(history.items[0].note, '문 앞');
});

// PoC pass criterion before Meatbox publishes its API: a driver event reaches the contract-3.1 receiver
// (our mock, contract 5) through the outbox, with the key, the status mapping and the photo URL.
test('Kotlin sends delivery-status messages to the mock Meatbox receiver after driver events', { timeout: 90_000 }, async t => {
  const fixture = await createFixture({ outbound: true });
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  const driver = `${days}/driver`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const event = (eventId, type, payload) => ({
    eventId, type, payload, occurredAt: '2026-11-02T10:41:00+09:00', date: fixture.today, vehicleId: 'TRUCK-1',
  });
  const post = (pathname, body) => requestJson(fixture, `${driver}${pathname}`, { method: 'POST', cookie, body });
  assert.equal((await post('/events', event('depart-1', 'departed', {}))).response.status, 202);
  const route = (await requestJson(fixture, `${driver}/route?vehicleId=TRUCK-1`, { cookie })).body;
  const first = route.stops[0];

  const form = new FormData();
  form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6])], { type: 'image/jpeg' }), 'proof.jpg');
  const upload = await fetch(`${fixture.origin}${driver}/photos`, {
    method: 'POST', headers: { Cookie: cookie, Origin: fixture.publicOrigin }, body: form,
  });
  const photo = await upload.json();
  const completed = await post('/events', event('complete-1', 'stop_completed', { stopId: first.stopId, photoIds: [photo.photoId], note: '문 앞' }));
  assert.equal(completed.response.status, 202, JSON.stringify(completed.body));

  // The receiver needs no session; poll up to 15 s for the sender's 1 s timer.
  const deadline = Date.now() + 15_000;
  let messages = [];
  while (Date.now() < deadline) {
    messages = (await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=delivery-status`)).json()).messages;
    if (messages.some(item => item.body.status === 'delivered')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const delivered = messages.filter(item => item.body.status === 'delivered');
  assert.equal(delivered.length, first.orderIds.length, JSON.stringify(messages));
  for (const item of delivered) {
    assert.equal(item.idempotencyKey, item.body.messageId);
    assert.equal(item.body.vehicleId, 'TRUCK-1');
    assert.equal(item.body.note, '문 앞');
    assert.deepEqual(item.body.photos, [`${fixture.publicOrigin}${driver}/photos/${photo.photoId}`]);
  }
  assert.ok(messages.some(item => item.body.status === 'dispatched'));
  assert.ok(messages.some(item => item.body.status === 'departed'));

  let outbox;
  do {
    outbox = await requestJson(fixture, `/api/ops/outbox?date=${fixture.today}`, { cookie });
    assert.equal(outbox.response.status, 200);
    if (outbox.body.pending > 0) await new Promise(resolve => setTimeout(resolve, 250));
  } while (outbox.body.pending > 0 && Date.now() < deadline);
  messages = (await (await fetch(`${fixture.origin}/mock/meatbox/received`)).json()).messages;
  assert.equal(outbox.body.pending, 0);
  assert.equal(outbox.body.failed, 0);
  assert.equal(outbox.body.sent, messages.length);
});

// Departure computes the per-stop ETA, shows it on the route and sends one contract-3.2 message to the receiver.
test('Kotlin computes ETAs at departure and sends one eta message to the mock Meatbox receiver', { timeout: 90_000 }, async t => {
  const fixture = await createFixture({ outbound: true });
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  const driver = `${days}/driver`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const before = (await requestJson(fixture, `${driver}/route?vehicleId=TRUCK-1`, { cookie })).body;
  assert.ok(before.stops.every(stop => stop.eta === null));

  const departed = await requestJson(fixture, `${driver}/events`, {
    method: 'POST', cookie, body: {
      eventId: 'eta-depart-1', type: 'departed', payload: {}, date: fixture.today, vehicleId: 'TRUCK-1',
      occurredAt: new Date().toISOString(), location: { lat: 37.5, lng: 127.0, accuracyM: 8 },
    },
  });
  assert.equal(departed.response.status, 202, JSON.stringify(departed.body));
  const route = (await requestJson(fixture, `${driver}/route?vehicleId=TRUCK-1`, { cookie })).body;
  const times = route.stops.map(stop => Date.parse(stop.eta));
  assert.ok(times.every(Number.isFinite), JSON.stringify(route.stops));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(route.next.eta, route.stops[0].eta);
  const snapshot = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  assert.equal(snapshot.vehicleStates['TRUCK-1'].eta.reason, 'departed');

  const deadline = Date.now() + 15_000;
  let messages = [];
  while (Date.now() < deadline) {
    messages = (await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=eta`)).json()).messages;
    if (messages.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(messages.length, 1, JSON.stringify(messages));
  const [message] = messages;
  assert.equal(message.idempotencyKey, message.body.messageId);
  assert.match(message.body.messageId, /^\d{4}-\d{2}-\d{2}-\d+-eta-TRUCK-1$/);
  assert.equal(message.body.vehicleId, 'TRUCK-1');
  assert.equal(message.body.reason, 'departed');
  assert.deepEqual(message.body.stops.map(stop => stop.eta), route.stops.map(stop => stop.eta));
  assert.deepEqual(message.body.stops.map(stop => stop.orderIds), route.stops.map(stop => stop.orderIds));

  let outbox;
  do {
    outbox = await requestJson(fixture, `/api/ops/outbox?date=${fixture.today}`, { cookie });
    if (outbox.body.pending > 0) await new Promise(resolve => setTimeout(resolve, 250));
  } while (outbox.body.pending > 0 && Date.now() < deadline);
  assert.equal(outbox.body.pending, 0);
  assert.equal(outbox.body.failed, 0);
});

// A stop that closes far from its due time recomputes the stops left and sends a second eta message with reason delayed.
test('Kotlin sends a delayed eta message to the mock Meatbox receiver after an early completion', { timeout: 90_000 }, async t => {
  const fixture = await createFixture({ outbound: true });
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  const driver = `${days}/driver`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const event = (eventId, type, payload) => requestJson(fixture, `${driver}/events`, {
    method: 'POST', cookie, body: {
      eventId, type, payload, date: fixture.today, vehicleId: 'TRUCK-1',
      occurredAt: new Date().toISOString(), location: { lat: 37.5, lng: 127.0, accuracyM: 8 },
    },
  });
  const received = async count => {
    const deadline = Date.now() + 15_000;
    let messages = [];
    while (Date.now() < deadline) {
      messages = (await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=eta`)).json()).messages;
      if (messages.length >= count) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return messages;
  };

  assert.equal((await event('late-depart-1', 'departed', {})).response.status, 202);
  assert.equal((await received(1)).length, 1);
  // The truck is about 16 km from the first stop, so closing it at once is far ahead of its due time.
  const closed = await event('late-done-1', 'stop_completed', { stopId: 'BUNDLE-1' });
  assert.equal(closed.response.status, 202, JSON.stringify(closed.body));
  const messages = await received(2);
  assert.equal(messages.length, 2, JSON.stringify(messages));
  const [first, second] = messages;
  assert.equal(first.body.reason, 'departed');
  assert.equal(second.body.reason, 'delayed');
  assert.equal(second.idempotencyKey, second.body.messageId);
  assert.match(second.body.messageId, /^\d{4}-\d{2}-\d{2}-\d+-eta-TRUCK-1-r1$/);
  assert.notEqual(second.body.messageId, first.body.messageId);
  assert.deepEqual(second.body.stops.map(stop => stop.sequence), [2, 3]);
  assert.ok(Date.parse(second.body.stops[0].eta) < Date.parse(first.body.stops[1].eta));
  const snapshot = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  assert.equal(snapshot.vehicleStates['TRUCK-1'].eta.reason, 'delayed');
  assert.ok(snapshot.vehicleStates['TRUCK-1'].eta.stops[0].actualAt);

  let outbox;
  const deadline = Date.now() + 15_000;
  do {
    outbox = await requestJson(fixture, `/api/ops/outbox?date=${fixture.today}`, { cookie });
    if (outbox.body.pending > 0) await new Promise(resolve => setTimeout(resolve, 250));
  } while (outbox.body.pending > 0 && Date.now() < deadline);
  assert.equal(outbox.body.pending, 0);
  assert.equal(outbox.body.failed, 0);
});

// An automatic order is a proposal: asking changes nothing, and the app applies it as route_reordered.
test('Kotlin proposes a stop order from the depot and the route follows it once the app applies it', { timeout: 90_000 }, async t => {
  // The depot sits at the last stop of the stored order, so the nearest-first order runs the stops backwards.
  const fixture = await createFixture({ depot: [37.49, 127.03] });
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  const driver = `${days}/driver`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const route = async () => (await requestJson(fixture, `${driver}/route?vehicleId=TRUCK-1`, { cookie })).body;
  const before = await route();
  assert.deepEqual(before.stops.map(stop => stop.stopId), ['BUNDLE-1', 'NEXT-1', 'NEXT-2']);

  const suggestion = await requestJson(fixture, `${driver}/route/suggest?vehicleId=TRUCK-1`, { method: 'POST', cookie });
  assert.equal(suggestion.response.status, 200, JSON.stringify(suggestion.body));
  assert.deepEqual(suggestion.body.stopOrder, ['NEXT-2', 'NEXT-1', 'BUNDLE-1']);
  assert.equal(suggestion.body.changed, true);
  assert.equal(suggestion.body.revision, before.revision);
  assert.ok(suggestion.body.totalKm > 0 && suggestion.body.totalMinutes > 0);
  assert.deepEqual(suggestion.body.placed, []);
  assert.deepEqual(await route(), before);
  assert.equal((await requestJson(fixture, `${days}/state`, { cookie })).body.revision, before.revision);

  const locked = await requestJson(fixture, `${driver}/route/suggest?vehicleId=TRUCK-1`, {
    method: 'POST', cookie, body: { lockFirst: 'NEXT-1' },
  });
  assert.equal(locked.body.stopOrder[0], 'NEXT-1');

  const applied = await requestJson(fixture, `${driver}/events`, {
    method: 'POST', cookie, body: {
      eventId: 'suggest-apply-1', type: 'route_reordered', date: fixture.today, vehicleId: 'TRUCK-1',
      occurredAt: new Date().toISOString(),
      payload: { stopOrder: suggestion.body.stopOrder, expectedRevision: suggestion.body.revision },
    },
  });
  assert.equal(applied.response.status, 202, JSON.stringify(applied.body));
  const after = await route();
  assert.deepEqual(after.stops.map(stop => stop.stopId), suggestion.body.stopOrder);
  const again = await requestJson(fixture, `${driver}/route/suggest?vehicleId=TRUCK-1`, { method: 'POST', cookie });
  assert.equal(again.body.changed, false);
  assert.equal(again.body.revision, after.revision);
});

// The driver reads are compressed by the server and answer 304 for an unchanged poll; the dispatch state, which
// compresses itself, is not compressed twice.
test('Kotlin compresses driver reads once, keeps the state endpoint single-encoded and answers 304 for a repeat poll', { timeout: 90_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const days = `/api/dispatch-data/days/${fixture.today}`;
  let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
  for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
    const body = commandFor(state, type, extra ?? { draftVersion: state.dispatch.draftVersion });
    const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    state = result.body.state;
  }
  const raw = (pathname, headers) => new Promise((resolve, reject) => {
    const request = http.request(`${fixture.origin}${pathname}`, { headers: { Cookie: cookie, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
  const decodedOnce = reply => JSON.parse(gunzipSync(reply.body).toString('utf8'));

  const stateReply = await raw(`${days}/state`, { 'Accept-Encoding': 'gzip' });
  assert.equal(stateReply.status, 200);
  assert.equal(stateReply.headers['content-encoding'], 'gzip');
  assert.equal(decodedOnce(stateReply).revision, state.revision, 'one gunzip must give the JSON, not a second gzip');

  const route = `${days}/driver/route?vehicleId=TRUCK-1`;
  const gzipped = await raw(route, { 'Accept-Encoding': 'gzip' });
  assert.equal(gzipped.status, 200);
  assert.equal(gzipped.headers['content-encoding'], 'gzip');
  const body = decodedOnce(gzipped);
  assert.deepEqual(body.stops.map(stop => stop.stopId), ['BUNDLE-1', 'NEXT-1', 'NEXT-2']);
  assert.equal(body.operable, true);
  assert.deepEqual(body.stops[0].coordinates, [126.81, 37.56]);
  assert.deepEqual(body.stops[0].orders.map(order => order.orderId), ['BUNDLE-1', 'BUNDLE-2']);
  assert.equal(body.vehicle.vehicleId, 'TRUCK-1');

  const plain = await raw(route, { 'Accept-Encoding': 'identity' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(plain.body.toString('utf8')), body);

  const etag = gzipped.headers.etag;
  assert.match(etag, /^W\/"route-[0-9a-f]+"$/);
  const repeat = await raw(route, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
  assert.equal(repeat.status, 304);
  assert.equal(repeat.body.length, 0);

  const vehicles = await raw(`${days}/driver/vehicles`, { 'Accept-Encoding': 'identity' });
  assert.equal(vehicles.status, 200);
  assert.deepEqual(JSON.parse(vehicles.body.toString('utf8')).vehicles.map(vehicle => [vehicle.vehicleId, vehicle.stops, vehicle.orders]), [['TRUCK-1', 3, 4], ['TRUCK-2', 0, 0]]);
});
