import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import accessModule from '../../lib/access.js';

const { createAccess } = accessModule;
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = '127.0.0.1';
const boss = { username: 'boss-user', password: 'boss-user-password-1', displayName: '운영 검증 사용자' };
const kim = { username: 'kim-driver', password: 'kim-driver-password-1', displayName: '김기사' };

function seoulDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
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

const javaBinary = () => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java');

async function startKotlin(settings) {
  const child = spawn(javaBinary(), [
    '-Xms64m', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-jar', settings.jar,
    '--server.address=127.0.0.1', `--server.port=${settings.port}`,
    '--meatbox.compat.enabled=true', `--meatbox.compat.legacy-api-origin=http://${host}:${settings.legacyPort}`,
    `--meatbox.compat.dispatch-data-dir=${settings.dataDirectory}`,
    '--meatbox.auth.enabled=true', `--meatbox.auth.access-file=${settings.accessFile}`,
    `--meatbox.auth.public-origin=${settings.publicOrigin}`,
    '--meatbox.dispatch.enabled=true', `--meatbox.dispatch.state-dir=${settings.stateDirectory}`,
    `--meatbox.dispatch.public-origin=${settings.publicOrigin}`,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const capture = chunk => { logs = (logs + chunk.toString()).slice(-32_768); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise(resolve => child.once('close', resolve));
  const close = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  };
  const origin = `http://${host}:${settings.port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kotlin exited before readiness:\n${logs}`);
    try {
      const response = await fetch(`${origin}/actuator/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === 'UP' && logs.includes('Started MeatboxApiApplication')) {
        return { origin, close };
      }
    } catch { /* bounded readiness polling */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await close();
  throw new Error(`Kotlin readiness timed out:\n${logs}`);
}

// The administration command of the JAR, as the runbook runs it: no web server, the role is required.
async function adminCommand(settings, properties) {
  const args = [
    '-Xmx128m', '-jar', settings.jar, '--spring.main.web-application-type=none', '--meatbox.auth.enabled=true',
    `--meatbox.auth.access-file=${settings.accessFile}`, `--meatbox.auth.public-origin=${settings.publicOrigin}`,
    ...Object.entries(properties).map(([key, value]) => `--meatbox.auth.${key}=${value}`),
  ];
  return execFileAsync(javaBinary(), args, { cwd: root, timeout: 60_000 }).then(
    result => ({ ok: true, ...result }),
    error => ({ ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );
}

// Two vehicles on today's prepared bundle: TRUCK-1 and TRUCK-2.
async function createFixture() {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-kotlin-roles-')));
  await fs.chmod(temporary, 0o700);
  const dataDirectory = path.join(temporary, 'dispatch-data');
  const stateDirectory = path.join(temporary, 'dispatch-state');
  const accessFile = path.join(temporary, 'access.json');
  const today = seoulDate();
  const order = (id, group, lng) => ({
    id, groupId: group, orderNumber: id, name: '합성 정육점', address: '검토 전용 가상주소', detailAddress: '',
    boxes: 1, sequence: 1, sourceRows: 1, coordinates: [lng, 37.56], zoneIds: ['WEST'],
  });
  const day = {
    schemaVersion: 1, date: today, summary: { orders: 2, boxes: 2 },
    groups: [
      { id: 'TRUCK-1', label: '(Z001) 합성 기사 1', regionNames: ['합성 권역'] },
      { id: 'TRUCK-2', label: '(Z002) 합성 기사 2', regionNames: ['합성 권역'] },
    ],
    orders: [order('CSV-1', 'TRUCK-1', 126.81), order('CSV-2', 'TRUCK-2', 126.82)],
  };
  const manifest = {
    schemaVersion: 1, defaultDate: today, dates: [{ date: today, summary: day.summary }],
    source: { csvSha256: createHash('sha256').update('kotlin-roles').digest('hex'), synthetic: true },
  };
  await fs.mkdir(path.join(dataDirectory, 'days'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDirectory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, `days/${today}.json`), JSON.stringify(day), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, 'regions.geojson'), '{"type":"FeatureCollection","features":[]}');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  // The operator is an account of the time before roles: it has no `role` field.
  const access = createAccess({ file: accessFile, now: () => Date.now() });
  await access.register({ ...boss, invite: await access.issueInvite() });
  const [port, legacyPort, publicPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const settings = {
    jar: await bootJarPath(), port, legacyPort, publicOrigin: `http://${host}:${publicPort}`,
    dataDirectory, stateDirectory, accessFile,
  };
  return { today, temporary, settings, ...settings };
}

async function login(fixture, account) {
  const response = await fetch(`${fixture.origin}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: fixture.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: account.username, password: account.password, next: '/combined/' }),
  });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function requestJson(fixture, pathname, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: fixture.publicOrigin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function assertProblem(result, status, code) {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  assert.match(result.response.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(result.body.code, code);
}

test('an operator invites a driver, assigns a vehicle, and the driver reaches that vehicle and nothing else through the actual JAR', { timeout: 180_000 }, async t => {
  const fixture = await createFixture();
  let kotlin;
  t.after(async () => {
    await kotlin?.close();
    await fs.rm(fixture.temporary, { recursive: true, force: true });
  });

  // The invitation command refuses to guess a role, then issues a driver invitation.
  const noRole = await adminCommand(fixture.settings, {
    'admin-command': 'issue-invite', 'admin-output': path.join(fixture.temporary, 'none.txt'),
  });
  assert.equal(noRole.ok, false);
  await assert.rejects(fs.stat(path.join(fixture.temporary, 'none.txt')));
  const inviteFile = path.join(fixture.temporary, 'invite.txt');
  const issued = await adminCommand(fixture.settings, {
    'admin-command': 'issue-invite', 'admin-role': 'driver', 'admin-output': inviteFile,
  });
  assert.equal(issued.ok, true, issued.stderr);
  const invite = (await fs.readFile(inviteFile, 'utf8')).trim();

  kotlin = await startKotlin(fixture.settings);
  fixture.origin = kotlin.origin;
  const registered = await fetch(`${fixture.origin}/dev/register`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: fixture.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ invite, username: kim.username, displayName: kim.displayName, password: kim.password }),
  });
  assert.equal(registered.status, 303);

  const opsCookie = await login(fixture, boss);
  const driverCookie = await login(fixture, kim);
  const day = `/api/dispatch-data/days/${fixture.today}`;

  await t.test('the session tells each account its role; an account from before roles is an operator', async () => {
    assert.equal((await requestJson(fixture, '/api/session', { cookie: opsCookie })).body.user.role, 'ops');
    assert.equal((await requestJson(fixture, '/api/session', { cookie: driverCookie })).body.user.role, 'driver');
  });

  await t.test('before any assignment the driver sees no vehicle and no route', async () => {
    const vehicles = await requestJson(fixture, `${day}/driver/vehicles`, { cookie: driverCookie });
    assert.equal(vehicles.response.status, 200);
    assert.deepEqual(vehicles.body.vehicles, []);
    assertProblem(await requestJson(fixture, `${day}/driver/route?vehicleId=TRUCK-1`, { cookie: driverCookie }), 403, 'VEHICLE_NOT_ASSIGNED');
  });

  await t.test('an operator assigns the driver; the driver is refused the assignment screen itself', async () => {
    const listed = await requestJson(fixture, '/api/ops/driver-assignments', { cookie: opsCookie });
    assert.deepEqual(listed.body.drivers.map(driver => driver.username), [kim.username]);
    assertProblem(await requestJson(fixture, '/api/ops/driver-assignments/TRUCK-1', {
      method: 'PUT', cookie: driverCookie, body: { revision: 0, driver: kim.username },
    }), 403, 'ROLE_FORBIDDEN');
    const assigned = await requestJson(fixture, '/api/ops/driver-assignments/TRUCK-1', {
      method: 'PUT', cookie: opsCookie, body: { revision: 0, driver: kim.username },
    });
    assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
    assertProblem(await requestJson(fixture, '/api/ops/driver-assignments/TRUCK-2', {
      method: 'PUT', cookie: opsCookie, body: { revision: 0, driver: kim.username },
    }), 409, 'ASSIGNMENT_REVISION_CONFLICT');
  });

  await t.test('the driver lists and reads the assigned vehicle only', async () => {
    const vehicles = await requestJson(fixture, `${day}/driver/vehicles`, { cookie: driverCookie });
    assert.deepEqual(vehicles.body.vehicles.map(vehicle => vehicle.vehicleId), ['TRUCK-1']);
    assert.equal((await requestJson(fixture, `${day}/driver/route?vehicleId=TRUCK-1`, { cookie: driverCookie })).response.status, 200);
    assertProblem(await requestJson(fixture, `${day}/driver/route?vehicleId=TRUCK-2`, { cookie: driverCookie }), 403, 'VEHICLE_NOT_ASSIGNED');
    assertProblem(await requestJson(fixture, `${day}/driver/history?vehicleId=TRUCK-2`, { cookie: driverCookie }), 403, 'VEHICLE_NOT_ASSIGNED');
    const operator = await requestJson(fixture, `${day}/driver/vehicles`, { cookie: opsCookie });
    assert.deepEqual(operator.body.vehicles.map(vehicle => vehicle.vehicleId).sort(), ['TRUCK-1', 'TRUCK-2']);
  });

  await t.test('the driver is refused every business route, and the operator is not', async () => {
    for (const route of [`${day}/state`, `${day}`, '/api/dispatch-data/manifest', '/api/dispatch-data/regions', '/api/ops/alerts']) {
      assertProblem(await requestJson(fixture, route, { cookie: driverCookie }), 403, 'ROLE_FORBIDDEN');
      assert.equal((await requestJson(fixture, route, { cookie: opsCookie })).response.status, 200, route);
    }
    assertProblem(await requestJson(fixture, `${day}/commands`, {
      method: 'POST', cookie: driverCookie, body: { type: 'calculate_dispatch' },
    }), 403, 'ROLE_FORBIDDEN');
    assertProblem(await requestJson(fixture, '/api/dispatch-data/manifest'), 401, 'LOGIN_REQUIRED');
  });

  await t.test('taking the vehicle away closes it for the driver at once', async () => {
    const cleared = await requestJson(fixture, '/api/ops/driver-assignments/TRUCK-1', {
      method: 'PUT', cookie: opsCookie, body: { revision: 1, driver: null },
    });
    assert.equal(cleared.response.status, 200);
    assertProblem(await requestJson(fixture, `${day}/driver/route?vehicleId=TRUCK-1`, { cookie: driverCookie }), 403, 'VEHICLE_NOT_ASSIGNED');
  });

  await t.test('set-role takes an operator account to a driver on its next request', async () => {
    const changed = await adminCommand(fixture.settings, {
      'admin-command': 'set-role', 'admin-username': boss.username, 'admin-role': 'driver',
    });
    assert.equal(changed.ok, true, changed.stderr);
    assertProblem(await requestJson(fixture, '/api/ops/alerts', { cookie: opsCookie }), 403, 'ROLE_FORBIDDEN');
    assert.equal((await requestJson(fixture, '/api/session', { cookie: opsCookie })).body.user.role, 'driver');
  });
});
