import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import accessModule from '../../lib/access.js';

const { createAccess } = accessModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = '127.0.0.1';
const user = { username: 'telemetry-user', password: 'telemetry-user-1234', displayName: '온도 검증 사용자' };
const token = 'telemetry-token-for-the-jar-test';

// RFC 9457 body with the web-compat `error` mirror, for fetch responses.
function assertProblem(result, status, code) {
  assert.equal(result.response.status, status);
  assert.match(result.response.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(result.body.status, status);
  assert.equal(result.body.code, code);
  assert.equal(result.body.error, code);
}

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

async function bootJarPath() {
  const directory = path.join(root, 'services/api/build/libs');
  const jars = (await fs.readdir(directory)).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  assert.equal(jars.length, 1, 'build exactly one Kotlin bootJar before this actual-JAR test');
  return path.join(directory, jars[0]);
}

async function startKotlin(settings) {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const child = spawn(java, [
    '-Xms64m', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-jar', settings.jar,
    '--server.address=127.0.0.1', `--server.port=${settings.port}`,
    '--meatbox.compat.enabled=true', `--meatbox.compat.legacy-api-origin=http://${host}:${settings.legacyPort}`,
    `--meatbox.compat.dispatch-data-dir=${settings.dataDirectory}`,
    '--meatbox.auth.enabled=true', `--meatbox.auth.access-file=${settings.accessFile}`,
    `--meatbox.auth.public-origin=${settings.publicOrigin}`,
    '--meatbox.dispatch.enabled=true', `--meatbox.dispatch.state-dir=${settings.stateDirectory}`,
    `--meatbox.dispatch.public-origin=${settings.publicOrigin}`,
    '--meatbox.mock-receiver.enabled=true', '--meatbox.outbound.interval-seconds=1',
    `--meatbox.outbound.base-url=http://${host}:${settings.port}/mock/meatbox`,
    ...(settings.token ? [`--meatbox.telemetry.token=${settings.token}`, '--meatbox.telemetry.batch-seconds=1'] : []),
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

// The prepared bundle has today only; one vehicle (TRUCK-1) is dispatched so the day snapshot has a vehicle state.
async function createFixture({ withToken = true } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-kotlin-telemetry-')));
  await fs.chmod(temporary, 0o700);
  const dataDirectory = path.join(temporary, 'dispatch-data');
  const stateDirectory = path.join(temporary, 'dispatch-state');
  const accessFile = path.join(temporary, 'access.json');
  const today = seoulDate();
  const day = {
    schemaVersion: 1, date: today, summary: { orders: 1, boxes: 1 },
    groups: [{ id: 'TRUCK-1', label: '(Z001) 합성 기사', regionNames: ['합성 권역'] }],
    orders: [{
      id: 'CSV-1', groupId: 'TRUCK-1', orderNumber: 'CSV-1', name: '합성 정육점', address: '검토 전용 가상주소',
      detailAddress: '', boxes: 1, sequence: 1, sourceRows: 1, coordinates: [126.81, 37.56], zoneIds: ['WEST'],
    }],
  };
  const manifest = {
    schemaVersion: 1, defaultDate: today, dates: [{ date: today, summary: day.summary }],
    source: { csvSha256: createHash('sha256').update('kotlin-telemetry').digest('hex'), synthetic: true },
  };
  await fs.mkdir(path.join(dataDirectory, 'days'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDirectory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, `days/${today}.json`), JSON.stringify(day), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, 'regions.geojson'), '{"type":"FeatureCollection","features":[]}');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const access = createAccess({ file: accessFile, now: () => Date.now() });
  await access.register({ ...user, invite: await access.issueInvite() });
  const [port, legacyPort, publicPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const settings = {
    jar: await bootJarPath(), port, legacyPort, publicOrigin: `http://${host}:${publicPort}`,
    dataDirectory, stateDirectory, accessFile, token: withToken ? token : '',
  };
  let kotlin = await startKotlin(settings);
  let closed = false;
  return {
    today, ...settings,
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

async function login(fixture) {
  const response = await fetch(`${fixture.origin}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: fixture.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user.username, password: user.password, next: '/combined/' }),
  });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function requestJson(fixture, pathname, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' ? { Origin: fixture.publicOrigin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function at(secondsAgo) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function push(fixture, body, { auth = `Bearer ${token}` } = {}) {
  return fetch(`${fixture.origin}/api/telemetry/temperature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  }).then(async response => ({ response, body: await response.json() }));
}

async function received(fixture, count) {
  const deadline = Date.now() + 15_000;
  let messages = [];
  while (Date.now() < deadline && messages.length < count) {
    messages = (await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=temperature`)).json()).messages;
    if (messages.length < count) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return messages;
}

test('a terminal pushes temperatures that are stored, read back, shown on the day and sent in a minute batch through the actual JAR', { timeout: 120_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  const state = `/api/dispatch-data/days/${fixture.today}/state`;
  const sample = vehicleId => ({
    vehicleId, sensorId: 'STEGO-7731',
    measurements: [90, 60, 30].map((secondsAgo, index) => ({ measuredAt: at(secondsAgo), celsius: -18.4 + index * 0.1, compartment: 'frozen' })),
  });

  await t.test('guards the endpoint with the telemetry token', async () => {
    for (const auth of [null, 'Bearer wrong-token-wrong-token']) {
      assertProblem(await push(fixture, sample('TRUCK-1'), { auth }), 401, 'TELEMETRY_UNAUTHORIZED');
    }
    const bad = await push(fixture, { ...sample('TRUCK-1'), measurements: [{ measuredAt: at(30), celsius: 99 }] });
    assertProblem(bad, 400, 'TEMPERATURE_OUT_OF_BOUNDS');
  });

  await t.test('stores a batch, ignores a resend and reads latest and history with a session', async () => {
    const fixed = sample('TRUCK-1');
    const first = await push(fixture, fixed);
    assert.equal(first.response.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.accepted, 3);
    const resend = await push(fixture, fixed);
    assert.deepEqual([resend.response.status, resend.body.accepted, resend.body.duplicate], [202, 0, 3]);
    const denied = await requestJson(fixture, '/api/telemetry/temperature/latest');
    assertProblem(denied, 401, 'LOGIN_REQUIRED');
    const latest = (await requestJson(fixture, '/api/telemetry/temperature/latest', { cookie })).body.vehicles;
    const row = latest.find(item => item.vehicleId === 'TRUCK-1');
    assert.equal(row.sensorId, 'STEGO-7731');
    assert.ok(Math.abs(row.celsius - -18.2) < 1e-9);
    assert.equal(row.stale, false);
    assert.equal(row.outOfRange, false);
    assert.deepEqual(row.range, { min: null, max: -18 });
    const history = (await requestJson(fixture, `/api/telemetry/temperature/TRUCK-1?from=${encodeURIComponent(at(300))}`, { cookie })).body;
    assert.equal(history.measurements.length, 3);
  });

  await t.test('shows the value on today\'s snapshot once the vehicle is dispatched', async () => {
    let current = (await requestJson(fixture, state, { cookie })).body;
    assert.equal(current.vehicleStates['TRUCK-1'], undefined);
    for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['TRUCK-1'] }], ['publish_dispatch', null]]) {
      const body = { type, expectedBoot: current.boot, expectedRevision: current.revision, ...(extra ?? { draftVersion: current.dispatch.draftVersion }) };
      const result = await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/commands`, { method: 'POST', cookie, body });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      current = result.body.state;
    }
    const shown = (await requestJson(fixture, state, { cookie })).body;
    assert.equal(shown.vehicleStates['TRUCK-1'].temperature.stale, false);
    assert.ok(Math.abs(shown.vehicleStates['TRUCK-1'].temperature.celsius - -18.2) < 1e-9);
    assert.ok(shown.sourceData.temperatureVersion > 0);
    const route = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/driver/route?vehicleId=TRUCK-1`, { cookie })).body;
    assert.equal(route.temperature.outOfRange, false);
  });

  await t.test('sends one batch to the Meatbox receiver and reports no pending message', async () => {
    const [message] = await received(fixture, 1);
    assert.equal(message.kind, 'temperature');
    assert.equal(message.idempotencyKey, message.body.messageId);
    assert.match(message.body.messageId, /^TRUCK-1-\d{12}-STEGO-7731$/);
    assert.equal(message.body.vehicleId, 'TRUCK-1');
    assert.equal(message.body.sensorId, 'STEGO-7731');
    assert.equal(message.body.measurements.length, 3);
    assert.deepEqual(Object.keys(message.body.measurements[0]), ['measuredAt', 'celsius']);
    assert.match(message.body.measurements[0].measuredAt, /\+09:00$/);
    const deadline = Date.now() + 10_000;
    let summary;
    while (Date.now() < deadline) {
      summary = (await requestJson(fixture, '/api/ops/telemetry', { cookie })).body;
      if (summary.sent >= 1 && summary.pending === 0) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.deepEqual([summary.pending, summary.failed, summary.sent], [0, 0, 1]);
    const alerts = (await requestJson(fixture, '/api/ops/alerts', { cookie })).body.alerts;
    assert.equal(alerts.filter(item => item.subject.includes('telemetry')).length, 0);
  });

  await t.test('sends measurements that arrive later and nothing twice, also after a restart', async () => {
    const late = await push(fixture, { vehicleId: 'TRUCK-1', sensorId: 'STEGO-7731', measurements: [{ measuredAt: at(10), celsius: -17.9 }] });
    assert.equal(late.body.accepted, 1);
    const messages = await received(fixture, 2);
    assert.deepEqual(messages[1].body.measurements.map(item => item.celsius), [-17.9]);
    await fixture.restart();
    const relogin = await login(fixture);
    const latest = (await requestJson(fixture, '/api/telemetry/temperature/latest', { cookie: relogin })).body.vehicles;
    assert.equal(latest.find(item => item.vehicleId === 'TRUCK-1').celsius, -17.9);
    // The receiver's list lives in memory, so a restarted process shows only what it received itself.
    await new Promise(resolve => setTimeout(resolve, 3500));
    const none = (await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=temperature`)).json()).messages;
    assert.equal(none.length, 0, 'a sent batch is not sent again after a restart');
    const next = await push(fixture, { vehicleId: 'TRUCK-1', sensorId: 'STEGO-7731', measurements: [{ measuredAt: at(5), celsius: -17.8 }] });
    assert.equal(next.body.accepted, 1);
    const [after] = await received(fixture, 1);
    assert.deepEqual(after.body.measurements.map(item => item.celsius), [-17.8]);
  });
});

test('the temperature endpoint does not exist without MEATBOX_TELEMETRY_TOKEN', { timeout: 60_000 }, async t => {
  const fixture = await createFixture({ withToken: false });
  t.after(() => fixture.close());
  assertProblem(await push(fixture, { vehicleId: 'TRUCK-1', sensorId: 'S', measurements: [] }, { auth: null }), 404, 'NOT_FOUND');
  const cookie = await login(fixture);
  const latest = await requestJson(fixture, '/api/telemetry/temperature/latest', { cookie });
  assert.equal(latest.response.status, 200);
  assert.deepEqual(latest.body.vehicles, []);
});
