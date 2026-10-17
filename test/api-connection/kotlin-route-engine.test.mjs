import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const user = { username: 'route-user', password: 'route-user-1234', displayName: '경로 검증 사용자' };
const token = 'route-engine-token-for-the-jar-test';
const depot = { lat: 37.5665, lng: 126.978 };
const osrm = process.env.ROUTE_ENGINE_OSRM_URL;
const vroom = process.env.ROUTE_ENGINE_VROOM_URL;

// Seoul stops in a deliberately poor first order; real roads (rivers, bridges) differ from straight lines.
const stops = [
  ['S1', '잠실', 37.5133, 127.1001], ['S2', '여의도', 37.5219, 126.9245], ['S3', '성수', 37.5446, 127.0557],
  ['S4', '마포', 37.5563, 126.9086], ['S5', '강남역', 37.4979, 127.0276],
];

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
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function bootJarPath() {
  const directory = path.join(root, 'services/api/build/libs');
  const jars = (await fs.readdir(directory)).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  assert.equal(jars.length, 1, 'build exactly one Kotlin bootJar before this actual-JAR test');
  return path.join(directory, jars[0]);
}

async function startKotlin(settings, engine) {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const env = { ...process.env, ...(engine ? { MEATBOX_OSRM_BASE_URL: osrm, MEATBOX_VROOM_URL: vroom } : {}) };
  if (!engine) { delete env.MEATBOX_OSRM_BASE_URL; delete env.MEATBOX_VROOM_URL; }
  const child = spawn(java, [
    '-Xms64m', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-jar', settings.jar,
    '--server.address=127.0.0.1', `--server.port=${settings.port}`,
    '--meatbox.compat.enabled=true', `--meatbox.compat.legacy-api-origin=http://${host}:${settings.legacyPort}`,
    `--meatbox.compat.dispatch-data-dir=${settings.dataDirectory}`,
    '--meatbox.auth.enabled=true', `--meatbox.auth.access-file=${settings.accessFile}`,
    `--meatbox.auth.public-origin=${settings.publicOrigin}`,
    '--meatbox.dispatch.enabled=true', `--meatbox.dispatch.state-dir=${settings.stateDirectory}`,
    `--meatbox.dispatch.public-origin=${settings.publicOrigin}`,
    `--meatbox.route.depot-lat=${depot.lat}`, `--meatbox.route.depot-lng=${depot.lng}`,
    `--meatbox.inbound.token=${token}`, '--meatbox.inbound.group-count=1',
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (response.ok && logs.includes('Started MeatboxApiApplication')) return { origin, close };
    } catch { /* bounded readiness polling */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await close();
  throw new Error(`Kotlin readiness timed out:\n${logs}`);
}

async function createFixture(engine) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-kotlin-route-')));
  await fs.chmod(temporary, 0o700);
  const dataDirectory = path.join(temporary, 'dispatch-data');
  const stateDirectory = path.join(temporary, 'dispatch-state');
  const accessFile = path.join(temporary, 'access.json');
  const today = seoulDate();
  // The prepared bundle has today only; the pushed orders go to tomorrow.
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
    source: { csvSha256: 'a'.repeat(64), synthetic: true },
  };
  await fs.mkdir(path.join(dataDirectory, 'days'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDirectory, `days/${today}.json`), JSON.stringify(day), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await fs.writeFile(path.join(dataDirectory, 'regions.geojson'), '{"type":"FeatureCollection","features":[]}');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const access = createAccess({ file: accessFile, now: () => Date.now() });
  await access.register({ ...user, invite: await access.issueInvite() });
  const [port, legacyPort, publicPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const settings = {
    jar: await bootJarPath(), port, legacyPort, publicOrigin: `http://${host}:${publicPort}`,
    dataDirectory, stateDirectory, accessFile,
  };
  const kotlin = await startKotlin(settings, engine);
  return {
    today, tomorrow: seoulDate(1), origin: kotlin.origin, publicOrigin: settings.publicOrigin,
    close: async () => { await kotlin.close(); await fs.rm(temporary, { recursive: true, force: true }); },
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

async function requestJson(fixture, pathname, { cookie, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' ? { Origin: fixture.publicOrigin, 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function orderBody(fixture, [id, name, lat, lng]) {
  return {
    orderId: id, version: 1, status: 'active', deliveryDate: fixture.tomorrow, deliveryType: 'fresh',
    customer: { name, phone: '010-0000-0000' },
    address: { road: `서울 ${name} ${id}`, detail: '1층', lat, lng },
    access: { entranceCode: '1234*', placeNote: '뒷문' },
    items: [{ sku: 'PK-001', name: '삼겹살', qty: 3, boxes: 2, weightKg: 3.2, barcode: '8801234567890' }],
    csNote: '오전 배송',
  };
}

// order intake -> confirm -> suggest -> departed -> ETA on one real JAR, with or without the road engine.
async function scenario(engine) {
  const fixture = await createFixture(engine);
  try {
    for (const stop of stops) {
      const body = orderBody(fixture, stop);
      const pushed = await fetch(`${fixture.origin}/api/meatbox/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${stop[0]}:1`, Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      assert.equal(pushed.status, 202, await pushed.text());
    }
    const cookie = await login(fixture);
    const days = `/api/dispatch-data/days/${fixture.tomorrow}`;
    const driver = `${days}/driver`;
    let state = (await requestJson(fixture, `${days}/state`, { cookie })).body;
    for (const [type, extra] of [['calculate_dispatch', { vehicleIds: ['api-g01'] }], ['publish_dispatch', null]]) {
      const body = { type, expectedBoot: state.boot, expectedRevision: state.revision, ...(extra ?? { draftVersion: state.dispatch.draftVersion }) };
      const result = await requestJson(fixture, `${days}/commands`, { method: 'POST', cookie, body });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      state = result.body.state;
    }
    const suggestion = await requestJson(fixture, `${driver}/route/suggest?vehicleId=api-g01`, { method: 'POST', cookie });
    assert.equal(suggestion.response.status, 200, JSON.stringify(suggestion.body));
    const departed = await requestJson(fixture, `${driver}/events`, {
      method: 'POST', cookie,
      body: {
        eventId: 'depart-1', type: 'departed', payload: {}, occurredAt: new Date().toISOString(),
        date: fixture.tomorrow, vehicleId: 'api-g01',
        location: { lat: depot.lat, lng: depot.lng, accuracyM: 8 },
      },
    });
    assert.equal(departed.response.status, 202, JSON.stringify(departed.body));
    const route = (await requestJson(fixture, `${driver}/route?vehicleId=api-g01`, { cookie })).body;
    const eta = (await requestJson(fixture, `${days}/state`, { cookie })).body.vehicleStates['api-g01'].eta;
    const dashboard = (await requestJson(fixture, `/api/ops/dashboard?from=${fixture.tomorrow}&to=${fixture.tomorrow}`, { cookie })).body;
    const vehicle = dashboard.days[0].vehicles[0];
    return { suggestion: suggestion.body, route, eta, vehicle };
  } finally {
    await fixture.close();
  }
}

const skip = osrm && vroom ? false : 'set ROUTE_ENGINE_OSRM_URL and ROUTE_ENGINE_VROOM_URL (see deploy/new-stack/route-engine.md)';

test('the actual JAR times the route on roads when the engine is configured and on straight lines when it is not', { timeout: 180_000, skip }, async () => {
  const plain = await scenario(false);
  const road = await scenario(true);
  const names = Object.fromEntries(stops.map(([id, name]) => [id, name]));
  const minutes = eta => eta.stops.map(stop => `${names[stop.stopId] ?? stop.stopId} ${stop.eta.slice(11, 16)}`).join(' -> ');
  const line = (label, run) => console.log(
    `${label}: departed=${run.eta.departedAt.slice(11, 16)} engine=${run.eta.engine ?? '(none)'} suggest.engine=${run.suggestion.engine ?? '(none)'} `
    + `order=${run.suggestion.stopOrder.map(id => names[id] ?? id).join(',')} `
    + `totalKm=${run.suggestion.totalKm} totalMinutes=${run.suggestion.totalMinutes} `
    + `dashboard=${run.vehicle.distanceKm}km/${run.vehicle.distanceBasis}\n  ETA ${minutes(run.eta)}`,
  );
  line('haversine (engine not configured)', plain);
  line('osrm+vroom (engine configured)   ', road);

  assert.equal(plain.eta.engine, undefined);
  assert.equal(plain.suggestion.engine, undefined);
  assert.equal(plain.vehicle.distanceBasis, 'estimate');
  assert.equal(road.eta.engine, 'osrm');
  assert.equal(road.suggestion.engine, 'vroom');
  assert.equal(road.vehicle.distanceBasis, 'road-plan');
  assert.notDeepEqual(road.eta.stops.map(stop => stop.eta), plain.eta.stops.map(stop => stop.eta));
  assert.notEqual(road.vehicle.distanceKm, plain.vehicle.distanceKm);
});
