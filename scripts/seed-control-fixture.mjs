// Fills a running native fixture (`MEATBOX_FORK_FIXTURE_TELEMETRY_TOKEN=... node scripts/web-fork-fixture.mjs --native`) with what the
// control screen shows once a day is under way: a published dispatch on two vehicles, today's synthetic temperatures (one vehicle in
// range, one out of range, one that stops reporting), a driver account with an assigned vehicle and its departure, which gives the
// server ETA. Synthetic data only; nothing is written outside the fixture.
import fs from 'node:fs/promises';
import { createAccess } from '../lib/access.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((item, index, all) => item.startsWith('--') ? [[item.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]] : []));
const origin = String(args.origin ?? 'http://127.0.0.1:4173');
const accessFile = args['access-file'];
const token = String(args.token ?? process.env.MEATBOX_FORK_FIXTURE_TELEMETRY_TOKEN ?? '');
if (!accessFile || !token) throw new Error('Usage: node scripts/seed-control-fixture.mjs --access-file <path> --token <telemetry token> [--origin <url>] [--keep-alive]');
const reviewer = { username: 'fork-reviewer', password: 'local-fork-1234' };
const driver = { username: 'fork-driver', password: 'local-driver-1234', displayName: '합성 기사 김' };

async function login(account) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: account.username, password: account.password, next: '/combined/' }),
  });
  if (response.status !== 303) throw new Error(`login ${account.username} failed: ${response.status}`);
  return response.headers.get('set-cookie').split(';', 1)[0];
}
async function call(cookie, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method, headers: { cookie, ...(method !== 'GET' ? { Origin: origin, 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// 1. a published dispatch on two vehicles
const ops = await login(reviewer);
const day = `/api/dispatch-data/days/${today}`;
let state = await call(ops, `${day}/state`);
const run = async (type, extra) => {
  const result = await call(ops, `${day}/commands`, { method: 'POST', body: { type, expectedBoot: state.boot, expectedRevision: state.revision, ...extra } });
  state = result.state;
};
if (state.dispatch.phase === 'unplanned' || state.dispatch.phase === 'draft') {
  await run('calculate_dispatch', { vehicleIds: ['TRUCK-1', 'TRUCK-2'] });
  await run('reassign', { orderIds: ['NEXT-1'], targetVehicleId: 'TRUCK-2' });
  await run('publish_dispatch', { draftVersion: state.dispatch.draftVersion });
}

// 2. today's temperatures, one reading a minute since midnight (Seoul): TRUCK-1 stays in range with a gap, TRUCK-2 climbs out of range
const startOfDay = Date.parse(`${today}T00:00:00+09:00`);
const nowMs = Date.now();
const minutes = Math.min(Math.floor((nowMs - startOfDay) / 60_000), 1439);
const stamp = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const series = (vehicleId, sensorId, value) => Array.from({ length: minutes }, (_, minute) => ({ minute, celsius: value(minute) }))
  .filter(item => !(vehicleId === 'TRUCK-1' && item.minute > 90 && item.minute < 105))
  .map(item => ({ measuredAt: stamp(startOfDay + item.minute * 60_000), celsius: Math.round(item.celsius * 10) / 10, compartment: 'frozen' }));
const push = async (vehicleId, sensorId, measurements) => {
  for (let at = 0; at < measurements.length; at += 400) {
    const response = await fetch(`${origin}/api/telemetry/temperature`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vehicleId, sensorId, measurements: measurements.slice(at, at + 400) }),
    });
    if (!response.ok) throw new Error(`telemetry ${vehicleId}: ${response.status} ${await response.text()}`);
  }
};
const wave = (minute, base, swing) => base + Math.sin(minute / 37) * swing + Math.sin(minute / 5) * 0.15;
await push('TRUCK-1', 'STEGO-A', series('TRUCK-1', 'STEGO-A', minute => wave(minute, -18.6, 0.5)));
await push('TRUCK-2', 'STEGO-B', series('TRUCK-2', 'STEGO-B', minute => (minute > minutes - 8 ? -9.5 + (minute - minutes) / 10 : wave(minute, -19, 0.4))));
// The server judges "out of range" only on readings newer than its stale window, so the last readings are taken just now.
const recent = (celsius, count) => Array.from({ length: count }, (_, index) => ({ measuredAt: stamp(Date.now() - (count - index) * 8_000), celsius, compartment: 'frozen' }));
await push('TRUCK-2', 'STEGO-B', recent(-9.5, 4));
await push('TRUCK-3', 'STEGO-C', series('TRUCK-3', 'STEGO-C', minute => wave(minute, -18.2, 0.3)).slice(-20));

// 3. a driver account with a vehicle, and its departure
const setup = createAccess({ file: accessFile });
if (!(JSON.parse(await fs.readFile(accessFile, 'utf8')).users[driver.username])) {
  await setup.register({ ...driver, invite: await setup.issueInvite() });
  const access = JSON.parse(await fs.readFile(accessFile, 'utf8'));
  access.users[driver.username].role = 'driver';
  const temporary = `${accessFile}.seed`;
  await fs.writeFile(temporary, JSON.stringify(access, null, 2), { mode: 0o600 });
  await fs.rename(temporary, accessFile);
}
const assignments = await call(ops, '/api/ops/driver-assignments');
if (!assignments.assignments.some(item => item.vehicleId === 'TRUCK-1')) {
  await call(ops, '/api/ops/driver-assignments/TRUCK-1', { method: 'PUT', body: { revision: assignments.revision, driver: driver.username } });
}
const driverCookie = await login(driver);
const route = await call(driverCookie, `${day}/driver/route?vehicleId=TRUCK-1`);
if (route.phase !== 'delivering' && route.operable) {
  await call(driverCookie, `${day}/driver/events`, { method: 'POST', body: {
    eventId: `seed-depart-${today}`, type: 'departed', occurredAt: new Date().toISOString(), date: today, vehicleId: 'TRUCK-1', payload: {},
    location: { lat: 37.5, lng: 126.8 },
  } });
}
// Where the vehicles are: TRUCK-1 reports from the driver app just now, TRUCK-2 was last heard of twenty minutes ago.
const sample = (minutesAgo, lat, lng) => ({ at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), lat, lng, accuracyM: 10 });
await call(driverCookie, `${day}/driver/locations`, { method: 'POST', body: { vehicleId: 'TRUCK-1', samples: [sample(0.3, 37.5665, 126.978)] } });
await call(ops, `${day}/driver/locations`, { method: 'POST', body: { vehicleId: 'TRUCK-2', samples: [sample(20, 37.5172, 127.0473)] } });
console.log(JSON.stringify({ status: 'seeded', today, driver: driver.username, minutes }));

if (args['keep-alive']) {
  // TRUCK-1 keeps reporting so that it stays "정상" while TRUCK-2 and TRUCK-3 go quiet (with a short stale window they turn 미수신).
  const keep = () => push('TRUCK-1', 'STEGO-A', [{ measuredAt: stamp(Date.now()), celsius: Math.round(wave(minutes, -18.6, 0.5) * 10) / 10, compartment: 'frozen' }]).catch(() => undefined);
  setInterval(keep, 20_000);
  process.on('SIGINT', () => process.exit(0));
}
