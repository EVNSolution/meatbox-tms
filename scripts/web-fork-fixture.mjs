import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createDemo } from '../server.js';
import { createAccess } from '../lib/access.js';
import { createLegacyGateway } from '../apps/web/scripts/legacy-gateway.mjs';

// Public, disposable fixture credentials. These are never written to a real access store.
const reviewer = { username: 'fork-reviewer', password: 'local-fork-1234', displayName: '합성 포크 검토자' };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';

function fixturePort(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a valid port`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port > 65_535) throw new Error(`${name} must be a valid port`);
  return port;
}

function manifestSignature(manifest) {
  const shift = manifest.source.dateShift;
  return createHash('sha256').update(JSON.stringify([
    manifest.source.csvSha256,
    shift ? [shift.sourceDate, shift.operatingDate, shift.offsetDays] : null,
    manifest.dates.map(item => item.date).sort(),
  ])).digest('hex');
}

async function writeFixture(directory) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const dates = [yesterday, today];
  // The existing importer generates deterministic demo plates; no real vehicle is identified.
  const groups = [
    { id: 'TRUCK-1', label: '(Z001) 합성 기사 1', regionNames: ['합성 서울 권역'] },
    { id: 'TRUCK-2', label: '(Z001) 합성 기사 2', regionNames: ['합성 서울 권역'] },
  ];
  const orders = [
    { id: 'BUNDLE-1', orderNumber: 'FIXTURE-1001', destinationId: 'dst_fork_bundle', name: '합성 정육점 A', address: '검토 전용 가상주소 A', detailAddress: '가상 1층', boxes: 2, sequence: 1, coordinates: [126.81, 37.56] },
    { id: 'BUNDLE-2', orderNumber: 'FIXTURE-1002', destinationId: 'dst_fork_bundle', name: '합성 정육점 A', address: '검토 전용 가상주소 A', detailAddress: '가상 1층', boxes: 3, sequence: 2, coordinates: [126.81, 37.56] },
    { id: 'NEXT-1', orderNumber: 'FIXTURE-1003', destinationId: 'dst_fork_next', name: '합성 식당 B', address: '검토 전용 가상주소 B', detailAddress: '가상 2층', boxes: 4, sequence: 3, coordinates: [126.87, 37.52] },
  ].map(order => ({ ...order, groupId: 'TRUCK-1', sourceRows: 1, regionCode: 'Z001', regionName: '합성 서울 권역', zoneIds: ['FIXTURE-WEST'] }));
  const summary = { sourceRows: 3, boxes: 9, orders: 3, payments: 3, sites: 2, groups: 2, mappedOrders: 3, unmappedOrders: 0, uncoveredOrders: 0, multiZoneOrders: 0 };
  const weekdays = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'long' });
  const days = dates.map(date => ({ schemaVersion: 1, date, weekday: weekdays.format(new Date(`${date}T12:00:00+09:00`)), summary, groups, orders }));
  // This identifier only describes synthetic input. It is not a supplier CSV fingerprint.
  const source = { csvSha256: createHash('sha256').update(JSON.stringify({ fixture: 'synthetic-web-fork', days })).digest('hex'), synthetic: true };
  const manifest = { schemaVersion: 1, defaultDate: today, dates: days.map(({ date, weekday, summary: daySummary }) => ({ date, weekday, summary: daySummary })), source };
  const destinations = {
    schemaVersion: 1,
    source: { ...source, manifestSignature: manifestSignature(manifest) },
    destinations: [orders[0], orders[2]].map(order => ({
      id: order.destinationId, name: order.name, address: order.address, detailAddress: order.detailAddress,
      dates: dates.map(date => ({ date, regionNames: ['합성 서울 권역'], orderCount: order.id === 'BUNDLE-1' ? 2 : 1, boxCount: order.id === 'BUNDLE-1' ? 5 : 4 })),
    })),
  };
  const regions = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'FIXTURE-WEST', properties: { zoneId: 'FIXTURE-WEST', regionCode: 'Z001', regionName: '합성 서울 권역', orderCount: 3 }, geometry: { type: 'Polygon', coordinates: [[[126.78, 37.50], [126.90, 37.50], [126.90, 37.59], [126.78, 37.59], [126.78, 37.50]]] } }],
  };
  await fs.mkdir(path.join(directory, 'days'), { recursive: true, mode: 0o700 });
  for (const [filename, value] of [
    ['manifest.json', manifest], ['destinations.json', destinations], ['regions.geojson', regions],
    ...days.map(day => [`days/${day.date}.json`, day]),
  ]) {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(directory, filename), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(directory, `${filename}.gz`), gzipSync(bytes), { mode: 0o600 });
  }
  return { today, yesterday };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, host);
  });
}

async function startKotlin({ apiOrigin, dataDirectory, port, resources, resourceDatabasePath, publicOrigin, native, accessFile, stateDirectory, telemetryToken = '', telemetryStaleMinutes = '', inboundToken = '' }) {
  const libraries = path.join(root, 'services/api/build/libs');
  const jars = (await fs.readdir(libraries)).filter(name => name.endsWith('.jar') && !name.endsWith('-plain.jar'));
  if (jars.length !== 1) throw new Error('Build exactly one Kotlin bootJar before starting the connected fixture');
  const probe = net.createServer();
  await listen(probe, port);
  await new Promise(resolve => probe.close(resolve));
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const fixtureJar = path.join(path.dirname(accessFile), 'meatbox-api.jar');
  try { await fs.copyFile(path.join(libraries, jars[0]), fixtureJar, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const child = spawn(java, [
    // C1-only JIT: short-lived fixture JVMs spend ~40% less CPU on startup, so
    // the CPU-bound contract suite finishes sooner on 4-vCPU CI runners.
    '-Xms64m', '-Xmx256m', '-XX:TieredStopAtLevel=1', '-jar', fixtureJar,
    '--server.address=127.0.0.1', `--server.port=${port}`,
    '--meatbox.compat.enabled=true', `--meatbox.compat.legacy-api-origin=${apiOrigin}`,
    `--meatbox.compat.dispatch-data-dir=${dataDirectory}`,
    `--meatbox.resources.enabled=${resources}`, `--meatbox.resources.database=${resourceDatabasePath}`,
    `--meatbox.resources.public-origin=${publicOrigin}`,
    `--meatbox.auth.enabled=${native}`, `--meatbox.auth.access-file=${accessFile}`,
    `--meatbox.auth.public-origin=${publicOrigin}`, `--meatbox.dispatch.enabled=${native}`,
    `--meatbox.dispatch.state-dir=${stateDirectory}`, `--meatbox.dispatch.public-origin=${publicOrigin}`,
    // Optional: lets a seeding script push synthetic temperatures (scripts/seed-control-fixture.mjs).
    ...(inboundToken ? [`--meatbox.inbound.token=${inboundToken}`] : []),
    ...(telemetryToken ? [`--meatbox.telemetry.token=${telemetryToken}`, `--meatbox.telemetry.stale-minutes=${telemetryStaleMinutes || 10}`] : []),
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
  const origin = `http://${host}:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Kotlin fixture exited before readiness:\n${logs}`);
      try {
        const response = await fetch(`${origin}/actuator/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === 'UP' && logs.includes('Started MeatboxApiApplication')) {
          return { origin, close, child };
        }
      } catch { /* The process is still starting; readiness remains bounded by the deadline. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Kotlin fixture readiness timed out:\n${logs}`);
  } catch (error) {
    await close();
    throw error;
  }
}

export async function startForkFixture({ connected = false, resources = false, native = false, apiPort = 3001, webPort = 4173, kotlinPort = 8081, telemetryToken = '', telemetryStaleMinutes = '', inboundToken = '' } = {}) {
  if (native) { connected = true; resources = true; }
  if (resources && !connected) throw new Error('Kotlin resource ownership requires a connected fixture');
  for (const port of [apiPort, webPort, ...(connected ? [kotlinPort] : [])]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Fixture port must be valid');
  }
  if (new Set([apiPort, webPort, ...(connected ? [kotlinPort] : [])]).size !== (connected ? 3 : 2)) {
    throw new Error('Fixture ports must differ');
  }
  let temporary;
  let demo;
  let gateway;
  let kotlin;
  let cleanupPromise;
  let legacyClosePromise;
  const stopLegacy = () => { if (demo) legacyClosePromise ??= demo.close(); return legacyClosePromise; };
  async function cleanup() {
    cleanupPromise ??= (async () => {
      // Destroy proxied browser/WS connections before closing their only state writer.
      try { await gateway?.close(); }
      finally {
        try { await kotlin?.close(); }
        finally {
          try { await stopLegacy(); }
          finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
        }
      }
    })();
    return cleanupPromise;
  }

  try {
    const apiOrigin = `http://${host}:${apiPort}`;
    const publicOrigin = `http://${host}:${webPort}`;
    const distDirectory = path.join(root, 'apps/web/.runtime/dist');
    await fs.access(path.join(distDirectory, 'combined/index.html'));
    await fs.access(path.join(distDirectory, 'login/index.html'));
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-web-fork-fixture-')));
    await fs.chmod(temporary, 0o700);
    const dispatchDataDir = path.join(temporary, 'dispatch-data');
    const dispatchStateDir = path.join(temporary, 'dispatch-state');
    const resourceDatabasePath = path.join(temporary, 'resources/resources.sqlite');
    const { today } = await writeFixture(dispatchDataDir);
    await fs.mkdir(dispatchStateDir, { mode: 0o700 });
    const imported = spawnSync(process.execPath, [path.join(root, 'scripts/import-resource-catalog.mjs'), '--day', path.join(dispatchDataDir, 'days', `${today}.json`), '--output', resourceDatabasePath], { encoding: 'utf8' });
    if (imported.error || imported.status !== 0) throw new Error('Synthetic resource catalog import failed');

    // Every data setting is explicit; ACCESS_FILE, DISPATCH_* and RESOURCE_DATABASE are ignored.
    const accessFile = path.join(temporary, 'access.json');
    const setupAccess = createAccess({file: accessFile});
    const invite = await setupAccess.issueInvite();
    await setupAccess.register({...reviewer, invite});
    if (!native) {
      demo = createDemo({ accessFile, dispatchDataDir, dispatchStateDir, resourceDatabasePath, resourceOwner:resources ? 'kotlin' : 'node', origin: publicOrigin });
      await listen(demo.server, apiPort);
    }
    const kotlinSettings = { apiOrigin, dataDirectory: dispatchDataDir, port: kotlinPort, resources, resourceDatabasePath, publicOrigin, native, accessFile, stateDirectory:dispatchStateDir, telemetryToken, telemetryStaleMinutes, inboundToken };
    if (connected) kotlin = await startKotlin(kotlinSettings);
    gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin: kotlin?.origin, kotlinResources:resources, kotlinAuth:native, kotlinDispatch:native, publicOrigin, distDirectory });
    await listen(gateway.server, webPort);
    return {
      origin: publicOrigin, apiOrigin, kotlinOrigin: kotlin?.origin, today, synthetic: true,
      dataDirectory: dispatchDataDir, temporaryDirectory: temporary,
      resourceDatabasePath, accessFile, stateDirectory:dispatchStateDir,
      close: cleanup, stopKotlin: () => kotlin?.close(), stopLegacy,
      restartKotlin: async () => { await kotlin?.close(); kotlin = await startKotlin(kotlinSettings); },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function main() {
  let stopping = false;
  const startup = startForkFixture({
    connected: process.argv.includes('--kotlin'),
    resources: process.argv.includes('--resources'),
    native: process.argv.includes('--native'),
    apiPort: fixturePort('MEATBOX_FORK_FIXTURE_API_PORT', 3001),
    webPort: fixturePort('MEATBOX_FORK_FIXTURE_WEB_PORT', 4173),
    kotlinPort: fixturePort('MEATBOX_FORK_FIXTURE_KOTLIN_PORT', 8081),
    telemetryToken: process.env.MEATBOX_FORK_FIXTURE_TELEMETRY_TOKEN ?? '',
    telemetryStaleMinutes: process.env.MEATBOX_FORK_FIXTURE_TELEMETRY_STALE_MINUTES ?? '',
    inboundToken: process.env.MEATBOX_FORK_FIXTURE_INBOUND_TOKEN ?? '',
  });
  async function stop() {
    if (stopping) return;
    stopping = true;
    try { const fixture = await startup; await fixture.close(); process.exitCode = 0; }
    catch { console.error('Synthetic web fork fixture cleanup failed'); process.exitCode = 1; }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
  try {
    const fixture = await startup;
    if (!stopping) console.log(JSON.stringify({ status: 'ready', origin: fixture.origin, kotlinOrigin: fixture.kotlinOrigin, synthetic: true, accessFile: fixture.accessFile }));
  }
  catch (error) {
    console.error(`Synthetic web fork fixture failed: ${error.code || error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
