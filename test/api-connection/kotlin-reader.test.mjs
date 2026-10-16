import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { assertProblem } from './problem.mjs';
import { WebSocket } from 'ws';
import { startForkFixture } from '../../scripts/web-fork-fixture.mjs';

async function availablePorts() {
  const servers = Array.from({ length: 3 }, () => http.createServer());
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => server.listening && new Promise(resolve => server.close(resolve))));
  }
}

function requestRaw(origin, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(route, origin), { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Fixture request timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

function parsed(response) {
  const bytes = response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;
  return JSON.parse(bytes.toString('utf8'));
}

function rejectedUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'meatbox-state-v2', { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Removed simulation WebSocket rejection timed out'));
    }, 5000);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      response.once('end', () => {
        clearTimeout(timer);
        resolve(response.statusCode);
      });
    });
    socket.once('open', () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error('Removed simulation WebSocket unexpectedly opened'));
    });
    socket.once('error', error => {
      if (!String(error.message).includes('Unexpected server response')) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function sourceHashes(directory) {
  const days = (await fs.readdir(path.join(directory, 'days'))).map(name => `days/${name}`);
  const rootEntries = await fs.readdir(directory, { withFileTypes: true });
  const filenames = [...rootEntries.flatMap(entry => entry.isFile() ? [entry.name] : []), ...days];
  return Object.fromEntries(await Promise.all(filenames.map(async name => [name,
    createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex'),
  ])));
}

test('built Kotlin reader connects to the fork while Node remains the only writer', { timeout: 60_000 }, async t => {
  const [apiPort, webPort, kotlinPort] = await availablePorts();
  const fixture = await startForkFixture({ connected: true, apiPort, webPort, kotlinPort });
  t.after(() => fixture.close());
  const dayRoute = `/api/dispatch-data/days/${fixture.today}`;
  const reads = ['/api/dispatch-data/manifest', dayRoute, '/api/dispatch-data/regions', '/api/dispatch-data/destinations'];
  const before = await sourceHashes(fixture.dataDirectory);
  let cookie;
  const get = (route, headers = {}) => requestRaw(fixture.origin, route, { headers: { cookie, ...headers } });
  const jsonWrite = (route, body, method = 'POST', origin = fixture.origin) => requestRaw(fixture.origin, route, {
    method, headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const login = async () => {
    const response = await requestRaw(fixture.origin, '/login', {
      method: 'POST', headers: { origin: fixture.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'fork-reviewer', password: 'local-fork-1234', next: '/combined/' }).toString(),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    cookie = response.headers['set-cookie'][0].split(';', 1)[0];
  };

  await t.test('direct Kotlin and gateway reads require the existing server session', async () => {
    for (const origin of [fixture.origin, fixture.kotlinOrigin]) {
      for (const route of reads) {
        const response = await requestRaw(origin, route);
        assert.equal(response.status, 401);
        assertProblem(response, parsed(response), 401, 'LOGIN_REQUIRED');
        assert.equal(response.headers['x-meatbox-source-reader'], 'kotlin');
      }
    }
    await login();
    assert.equal((await get('/combined/')).status, 200);
  });

  await t.test('all four actual Kotlin reads preserve the Node JSON contract and query paths', async () => {
    for (const route of reads) {
      const legacy = await requestRaw(fixture.apiOrigin, route, { headers: { cookie } });
      const direct = await requestRaw(fixture.kotlinOrigin, route, { headers: { cookie } });
      const gateway = await get(route + '?reader-check=1');
      assert.equal(legacy.status, 200);
      assert.equal(direct.status, 200);
      assert.equal(gateway.status, 200);
      assert.deepEqual(parsed(direct), parsed(legacy));
      assert.deepEqual(parsed(gateway), parsed(legacy));
      assert.equal(gateway.headers['x-meatbox-source-reader'], 'kotlin');
      assert.match(gateway.headers['cache-control'], /no-store/);
      assert.equal(gateway.headers['x-content-type-options'], 'nosniff');
    }
  });

  await t.test('gzip, HEAD and conditional GET keep their HTTP semantics', async () => {
    const identity = await get(dayRoute, { 'accept-encoding': 'identity' });
    const compressed = await get(dayRoute, { 'accept-encoding': 'gzip' });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.deepEqual(parsed(compressed), parsed(identity));
    const head = await requestRaw(fixture.origin, dayRoute, { method: 'HEAD', headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['x-meatbox-source-reader'], 'kotlin');
    assert.ok(identity.headers.etag);
    const unchanged = await get(dayRoute, { 'if-none-match': identity.headers.etag, 'accept-encoding': 'identity' });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    for (const encoding of ['gzip;q=0.000', 'gzip;q=0,*;q=1']) {
      const declined = await get(dayRoute, { 'accept-encoding': encoding });
      assert.equal(declined.headers['content-encoding'], undefined);
      assert.deepEqual(parsed(declined), parsed(identity));
    }
  });

  await t.test('calendar-invalid and unlisted dates do not select arbitrary input files', async () => {
    for (const date of ['2026-02-30', '1900-01-01', '2026-99-99', `${fixture.today}.json`]) {
      const response = await get(`/api/dispatch-data/days/${date}`);
      assert.equal(response.status, 404);
      assertProblem(response, parsed(response), 404, 'DISPATCH_DATA_NOT_FOUND');
      assert.equal(response.headers['x-meatbox-source-reader'], 'kotlin');
    }
  });

  await t.test('missing and corrupt input retain errors without entering legacy mode or disclosing paths', async () => {
    const filename = path.join(fixture.dataDirectory, 'manifest.json');
    const bytes = await fs.readFile(filename);
    try {
      await fs.writeFile(filename, '{broken');
      const corrupt = await get(reads[0]);
      assert.equal(corrupt.status, 500);
      assertProblem(corrupt, parsed(corrupt), 500, 'DISPATCH_DATA_INVALID');
      assert.equal(corrupt.headers['x-meatbox-source-reader'], 'kotlin');
      await fs.unlink(filename);
      const absent = await get(reads[0]);
      assert.equal(absent.status, 404);
      assertProblem(absent, parsed(absent), 404, 'DISPATCH_DATA_UNAVAILABLE');
      assert.equal(absent.headers['x-meatbox-source-reader'], 'kotlin');
      assert.ok(!absent.body.includes(Buffer.from(fixture.dataDirectory)));
    } finally { await fs.writeFile(filename, bytes); }
  });

  await t.test('Node dispatch state and commands preserve Origin, boot, revision, calculate and publish', async () => {
    const stateRoute = `${dayRoute}/state`;
    const commandRoute = `${dayRoute}/commands`;
    const response = await get(stateRoute);
    assert.equal(response.headers['x-meatbox-source-reader'], undefined);
    const initial = parsed(response);
    const calculation = { type: 'calculate_dispatch', expectedRevision: initial.revision, expectedBoot: initial.boot, vehicleIds: ['TRUCK-1', 'TRUCK-2'] };
    const wrongOrigin = await jsonWrite(commandRoute, calculation, 'POST', 'https://attacker.invalid');
    assert.equal(wrongOrigin.status, 403);
    assert.equal(parsed(wrongOrigin).error, 'ORIGIN_REQUIRED');
    const wrongBoot = await jsonWrite(commandRoute, { ...calculation, expectedBoot: 'old-boot' });
    assert.equal(wrongBoot.status, 409);
    assert.equal(parsed(wrongBoot).error, 'BOOT_MISMATCH');
    const calculated = await jsonWrite(commandRoute, calculation);
    assert.equal(calculated.status, 200);
    const draft = parsed(calculated).state;
    assert.equal(draft.dispatch.phase, 'draft');
    assert.equal(draft.fleetDeliveries.length, 0);
    const stale = await jsonWrite(commandRoute, calculation);
    assert.equal(stale.status, 409);
    assert.equal(parsed(stale).error, 'REVISION_CONFLICT');
    const published = await jsonWrite(commandRoute, {
      type: 'publish_dispatch', expectedRevision: draft.revision, expectedBoot: draft.boot, draftVersion: draft.dispatch.draftVersion,
    });
    assert.equal(published.status, 200);
    assert.equal(parsed(published).state.dispatch.phase, 'published');
    assert.equal(parsed(published).state.fleetDeliveries.length, 3);
  });

  await t.test('logout invalidates the same cookie in Kotlin with no secondary auth store', async () => {
    const loggedOut = await requestRaw(fixture.origin, '/logout', { method: 'POST', headers: { cookie, origin: fixture.origin } });
    assert.equal(loggedOut.status, 303);
    assert.equal((await get(reads[0])).status, 401);
    await login();
    assert.equal((await get(reads[0])).status, 200);
  });

  await t.test('dated source and logout stay on HTTP while the removed WebSocket fails closed', async () => {
    const datedSource = await get(dayRoute);
    assert.equal(datedSource.status, 200);
    assert.equal(parsed(datedSource).date, fixture.today);
    assert.equal((await get('/api/session')).status, 200);

    const loggedOut = await requestRaw(fixture.origin, '/logout', { method: 'POST', headers: { cookie, origin: fixture.origin } });
    assert.equal(loggedOut.status, 303);
    assert.equal((await get('/api/session')).status, 401);
    assert.equal((await get(dayRoute)).status, 401);

    await login();
    assert.equal((await get(dayRoute)).status, 200);
    for (const route of [
      '/scenario/', '/scenario/customer', '/scenario/common.js', '/scenario/api/route-data',
      '/customer', '/driver', '/present', '/combined/driver.html', '/combined/mobile-customer.html',
    ]) {
      const removed = await get(route);
      assert.equal(removed.status, 410, route);
      assert.match(removed.body.toString('utf8'), /Old demo removed/, route);
    }
    const status = await rejectedUpgrade(`${fixture.origin.replace('http:', 'ws:')}/ws/simulation`, { cookie, origin: fixture.origin });
    assert.equal(status, 410);
    assert.deepEqual(await sourceHashes(fixture.dataDirectory), before);

    await fixture.stopKotlin();
    assert.equal((await get(reads[0])).status, 503);
    assert.equal((await requestRaw(fixture.apiOrigin, reads[0], { headers: { cookie } })).status, 200);
  });

  await t.test('fixture closes both backends and gateway and removes disposable input and stores', async () => {
    await fixture.close();
    await assert.rejects(fs.access(fixture.temporaryDirectory), { code: 'ENOENT' });
    for (const origin of [fixture.origin, fixture.apiOrigin, fixture.kotlinOrigin]) {
      await assert.rejects(requestRaw(origin, '/actuator/health'));
    }
  });
});
