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
import { adaptDispatchDay } from '../../apps/web/combined/dated-dispatch.mjs';

const { createAccess } = accessModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = '127.0.0.1';
const user = { username: 'inbound-user', password: 'inbound-user-1234', displayName: '수신 검증 사용자' };
const token = 'inbound-token-for-the-jar-test';

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
    ...(settings.token ? [`--meatbox.inbound.token=${settings.token}`, '--meatbox.inbound.group-count=3'] : []),
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

// The prepared bundle has today only. The pushed orders go to tomorrow, a date no bundle has.
async function createFixture({ withToken = true } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-kotlin-inbound-')));
  await fs.chmod(temporary, 0o700);
  const dataDirectory = path.join(temporary, 'dispatch-data');
  const stateDirectory = path.join(temporary, 'dispatch-state');
  const accessFile = path.join(temporary, 'access.json');
  const today = seoulDate();
  const tomorrow = seoulDate(1);
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
    source: { csvSha256: createHash('sha256').update('kotlin-inbound-orders').digest('hex'), synthetic: true },
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
    today, tomorrow, ...settings,
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

function orderBody(fixture, id, version, { status = 'active', boxes = 2, name = `가게 ${id}`, lat = 37.5, lng = 127.0 } = {}) {
  const base = { orderId: id, version, status, deliveryDate: fixture.tomorrow };
  if (status === 'cancelled') return base;
  return {
    ...base, deliveryType: 'fresh',
    customer: { name, phone: '010-0000-0000' },
    address: { road: `서울 강남구 ${id}`, detail: '지하 1층', lat, lng },
    access: { entranceCode: '1234*', placeNote: '뒷문' },
    items: [{ sku: 'PK-001', name: '삼겹살', qty: 3, boxes, weightKg: 3.2, barcode: '8801234567890' }],
    csNote: '오전 배송',
  };
}

function push(fixture, body, { auth = `Bearer ${token}`, key = `${body.orderId}:${body.version}` } = {}) {
  return fetch(`${fixture.origin}/api/meatbox/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  }).then(async response => ({ response, body: await response.json() }));
}

test('Meatbox pushes orders that dispatch, confirm, complete and report through the actual JAR', { timeout: 120_000 }, async t => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const days = `/api/dispatch-data/days/${fixture.tomorrow}`;
  const driver = `${days}/driver`;

  await t.test('guards the endpoint with the token and answers the idempotency rules', async () => {
    for (const auth of [null, 'Bearer wrong-token-wrong-token']) {
      const denied = await push(fixture, orderBody(fixture, 'A', 1), { auth });
      assertProblem(denied, 401, 'INBOUND_UNAUTHORIZED');
    }
    for (const id of ['A', 'B', 'C']) {
      const accepted = await push(fixture, orderBody(fixture, id, 1, { boxes: 2 }));
      assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
      assert.equal(accepted.body.applied, true);
    }
    const again = await push(fixture, orderBody(fixture, 'A', 1));
    assert.equal(again.response.status, 200);
    assert.equal(again.body.duplicate, true);
    const conflict = await push(fixture, orderBody(fixture, 'A', 1, { boxes: 9 }));
    assert.equal(conflict.response.status, 409);
    assertProblem(conflict, 409, 'ORDER_VERSION_CONFLICT');
    const second = await push(fixture, orderBody(fixture, 'B', 2, { boxes: 2 }));
    assert.equal(second.response.status, 202);
    const older = await push(fixture, orderBody(fixture, 'B', 1));
    assert.equal(older.response.status, 200);
    assert.equal(older.body.ignored, true);
    const mismatch = await push(fixture, orderBody(fixture, 'A', 1), { key: 'A:2' });
    assertProblem(mismatch, 400, 'IDEMPOTENCY_KEY_MISMATCH');
  });

  const cookie = await login(fixture);
  let state;
  await t.test('lists the pushed date and serves its three orders under a stable source id', async () => {
    const manifest = (await requestJson(fixture, '/api/dispatch-data/manifest', { cookie })).body;
    const entry = manifest.dates.find(item => item.date === fixture.tomorrow);
    assert.equal(entry.source, 'api');
    assert.equal(entry.orders, 3);
    assert.equal(manifest.dates.find(item => item.date === fixture.today).source, undefined);
    // The unchanged web fork must accept the generated day as it does a prepared one.
    const day = (await requestJson(fixture, days, { cookie })).body;
    const adapted = adaptDispatchDay(day, { type: 'FeatureCollection', features: [] });
    assert.equal(adapted.fleetDeliveries.length, 3);
    assert.equal(adapted.fleetVehicles.length, 3);
    state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    assert.deepEqual(state.dispatchOrders.map(order => order.id), ['A', 'B', 'C']);
    assert.match(state.sourceData.sourceId, /^api-[0-9a-f]{64}$/);
    assert.equal(state.sourceData.inbound.applied, 3);
    assert.equal(state.dispatch.phase, 'unplanned');
    const csv = (await requestJson(fixture, `/api/dispatch-data/days/${fixture.today}/state`, { cookie })).body;
    assert.equal(csv.sourceData.inbound, undefined);
  });

  let first;
  await t.test('calculates, confirms and starts the route on the pushed orders', async () => {
    for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['api-g01'] }], ['publish_dispatch', null]]) {
      const body = { type, expectedBoot: state.boot, expectedRevision: state.revision, ...(extra ?? { draftVersion: state.dispatch.draftVersion }) };
      const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      state = result.body.state;
    }
    assert.equal(state.dispatch.phase, 'published');
    const departed = await requestJson(fixture, `${driver}/events`, {
      method: 'POST', cookie,
      body: { eventId: 'depart-1', type: 'departed', payload: {}, occurredAt: '2026-11-02T09:00:00+09:00', date: fixture.tomorrow, vehicleId: 'api-g01' },
    });
    assert.equal(departed.response.status, 202, JSON.stringify(departed.body));
    first = (await requestJson(fixture, `${driver}/route?vehicleId=api-g01`, { cookie })).body.stops[0];
  });

  let completedOrder;
  await t.test('reports the completed stop to the Meatbox receiver as delivered', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6])], { type: 'image/jpeg' }), 'proof.jpg');
    const upload = await fetch(`${fixture.origin}${driver}/photos`, {
      method: 'POST', headers: { Cookie: cookie, Origin: fixture.publicOrigin }, body: form,
    });
    const photo = await upload.json();
    const completed = await requestJson(fixture, `${driver}/events`, {
      method: 'POST', cookie,
      body: {
        eventId: 'complete-1', type: 'stop_completed', payload: { stopId: first.stopId, photoIds: [photo.photoId], note: '문 앞' },
        occurredAt: '2026-11-02T10:41:00+09:00', date: fixture.tomorrow, vehicleId: 'api-g01',
      },
    });
    assert.equal(completed.response.status, 202, JSON.stringify(completed.body));
    completedOrder = first.orderIds[0];
    const deadline = Date.now() + 15_000;
    let delivered = [];
    while (Date.now() < deadline && delivered.length < first.orderIds.length) {
      const { messages } = await (await fetch(`${fixture.origin}/mock/meatbox/received?kind=delivery-status`)).json();
      delivered = messages.filter(item => item.body.status === 'delivered');
      if (delivered.length < first.orderIds.length) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.deepEqual(delivered.map(item => item.body.orderId).sort(), [...first.orderIds].sort());
    assert.equal(delivered[0].body.vehicleId, 'api-g01');
  });

  await t.test('keeps a confirmed day when Meatbox cancels or changes orders, and warns the operator', async () => {
    const before = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    const cancelled = await push(fixture, orderBody(fixture, 'C', 2, { status: 'cancelled' }));
    assert.equal(cancelled.response.status, 202);
    assert.equal(cancelled.body.applied, false);
    assert.equal(cancelled.body.held, 'ORDER_CANCELLED_AFTER_DISPATCH');
    const changedAfterDone = await push(fixture, orderBody(fixture, completedOrder, 2, { boxes: 7 }));
    assert.equal(changedAfterDone.body.held, 'ORDER_CHANGED_AFTER_COMPLETION');
    const after = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    assert.deepEqual(after.dispatchOrders.map(order => order.id), ['A', 'B', 'C']);
    assert.equal(after.sourceData.sourceId, before.sourceData.sourceId);
    assert.equal(after.revision, before.revision);
    assert.equal(after.dispatch.phase, 'published');
    assert.deepEqual(after.sourceData.inbound.warnings.map(warning => warning.code),
      ['ORDER_CANCELLED_AFTER_DISPATCH', 'ORDER_CHANGED_AFTER_COMPLETION']);
    const alerts = (await requestJson(fixture, '/api/ops/alerts', { cookie })).body.alerts;
    assert.equal(alerts.filter(item => item.subject.includes('ORDER_CANCELLED_AFTER_DISPATCH')).length, 1);
  });

  await t.test('restores the same day after a restart and still treats a resend as a duplicate', async () => {
    const before = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    await fixture.restart();
    const after = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    assert.equal(after.sourceData.sourceId, before.sourceData.sourceId);
    assert.deepEqual(after.dispatchOrders.map(order => [order.id, order.status]), before.dispatchOrders.map(order => [order.id, order.status]));
    assert.equal(after.dispatch.phase, 'published');
    const again = await push(fixture, orderBody(fixture, 'C', 2, { status: 'cancelled' }));
    assert.equal(again.response.status, 200);
    assert.equal(again.body.duplicate, true);
  });
});

test('the order endpoint does not exist without MEATBOX_INBOUND_TOKEN', { timeout: 60_000 }, async t => {
  const fixture = await createFixture({ withToken: false });
  t.after(() => fixture.close());
  const response = await push(fixture, orderBody(fixture, 'A', 1));
  assertProblem(response, 404, 'NOT_FOUND');
});
