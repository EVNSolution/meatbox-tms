import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertProblem } from './problem.mjs';
import { startForkFixture } from '../../scripts/web-fork-fixture.mjs';

const require = createRequire(import.meta.url);
const { createResourceStore } = require('../../lib/resource-store.js');

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
  return JSON.parse(response.body.toString('utf8'));
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertKotlinOwner(response) {
  assert.equal(response.headers['x-meatbox-resource-owner'], 'kotlin');
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

test('built Kotlin API exclusively owns the resource registry while Node keeps account sessions', { timeout: 90_000 }, async t => {
  const [apiPort, webPort, kotlinPort] = await availablePorts();
  const fixture = await startForkFixture({ connected: true, resources: true, apiPort, webPort, kotlinPort });
  t.after(() => fixture.close());

  const goldenDatabase = path.join(fixture.temporaryDirectory, 'resources', 'golden.sqlite');
  await fs.copyFile(fixture.resourceDatabasePath, goldenDatabase);
  const golden = createResourceStore(goldenDatabase);
  t.after(() => golden.close());

  let cookie;
  const request = (origin, route, options = {}) => requestRaw(origin, route, {
    ...options,
    headers: { ...(cookie === undefined ? {} : { cookie }), ...options.headers },
  });
  const write = (origin, route, body, method = 'POST', requestOrigin = fixture.origin) => request(origin, route, {
    method,
    headers: { origin: requestOrigin, 'content-type': 'application/json' },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const gatewayWrite = (route, body, method = 'POST', requestOrigin = fixture.origin) =>
    write(fixture.origin, route, body, method, requestOrigin);
  const login = async () => {
    const response = await requestRaw(fixture.origin, '/login', {
      method: 'POST',
      headers: { origin: fixture.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'fork-reviewer', password: 'local-fork-1234', next: '/combined/' }).toString(),
    });
    assert.equal(response.status, 303);
    cookie = response.headers['set-cookie'][0].split(';', 1)[0];
  };

  await t.test('direct Kotlin and gateway resource reads and writes require the existing Node session', async () => {
    for (const origin of [fixture.kotlinOrigin, fixture.origin]) {
      for (const [route, options] of [
        ['/api/resources', {}],
        ['/api/resources/region-codes', {
          method: 'POST',
          headers: { origin: fixture.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ revision: 0, code: 'ANONYMOUS' }),
        }],
      ]) {
        const response = await requestRaw(origin, route, options);
        assert.equal(response.status, 401);
        assertProblem(response, parsed(response), 401, 'LOGIN_REQUIRED');
        assertKotlinOwner(response);
      }
    }
    await login();
    assert.equal((await request(fixture.origin, '/api/session')).status, 200);
  });

  await t.test('snapshot GET and HEAD preserve the legacy shape through Kotlin and the gateway', async () => {
    const expected = jsonValue(golden.snapshot());
    for (const origin of [fixture.kotlinOrigin, fixture.origin]) {
      const response = await request(origin, '/api/resources?contract=raw%2Bvalue');
      assert.equal(response.status, 200);
      assert.deepEqual(parsed(response), expected);
      assertKotlinOwner(response);
      const head = await request(origin, '/api/resources', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assertKotlinOwner(head);
    }
  });

  await t.test('resource mutations reject cross-origin requests before changing the registry', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    const response = await gatewayWrite('/api/resources/region-codes', { revision: before.revision, code: 'NEW' }, 'POST', 'https://attacker.invalid');
    assert.equal(response.status, 403);
    assert.equal(parsed(response).error, 'ORIGIN_REQUIRED');
    assertKotlinOwner(response);
    assert.deepEqual(parsed(await request(fixture.origin, '/api/resources')), before);
  });

  await t.test('resource mutations reject malformed and oversized JSON without changing the registry', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    for (const body of [
      '{',
      '{"revision":0,"revision":0,"code":"DUPLICATE"}',
      JSON.stringify({ padding: 'x'.repeat(256 * 1024) }),
    ]) {
      const response = await gatewayWrite('/api/resources/region-codes', body);
      assert.equal(response.status, 400);
      assert.equal(parsed(response).error, 'INVALID_JSON');
      assertKotlinOwner(response);
    }
    assert.deepEqual(parsed(await request(fixture.origin, '/api/resources')), before);
  });

  await t.test('unknown resource routes and invalid inputs fail closed under Kotlin ownership', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    const cases = [
      ['/api/resources/categories', 'POST', { revision: before.revision, code: 'NEW' }, 404, undefined],
      ['/api/resources/region-codes', 'POST', { revision: before.revision, code: '한글' }, 400, 'INVALID_REGION_CODE'],
      ['/api/resources/region-codes', 'POST', { revision: before.revision, code: 'NEW', extra: true }, 400, 'INVALID_INPUT'],
      ['/api/resources/vehicles/UNKNOWN', 'PATCH', { revision: before.revision, regionCode: 'Z001' }, 404, 'VEHICLE_NOT_FOUND'],
      ['/api/resources/vehicles/TRUCK-1', 'PATCH', { revision: before.revision, regionCode: 'MISSING' }, 400, 'REGION_CODE_NOT_FOUND'],
    ];
    for (const [route, method, body, status, code] of cases) {
      const response = await gatewayWrite(route, body, method);
      assert.equal(response.status, status, route);
      if (code) assert.equal(parsed(response).error, code, route);
      assertKotlinOwner(response);
    }
    assert.deepEqual(parsed(await request(fixture.origin, '/api/resources')), before);
  });

  await t.test('all four mutations match the existing store including normalization and foreign-key cascade', async () => {
    const mutations = [
      {
        route: '/api/resources/region-codes', method: 'POST', body: { revision: 0, code: 'new' },
        expected: () => golden.createRegionCode(0, 'new'),
      },
      {
        route: '/api/resources/vehicles/TRUCK-1', method: 'PATCH', body: { revision: 1, regionCode: 'new' },
        expected: () => golden.assignVehicle(1, 'TRUCK-1', 'new'),
      },
      {
        route: '/api/resources/vehicles', method: 'PATCH', body: { revision: 2, assignments: [
          { id: 'TRUCK-1', regionCode: 'new' }, { id: 'TRUCK-2', regionCode: 'NEW' },
        ] },
        expected: () => golden.assignVehicles(2, [
          { id: 'TRUCK-1', regionCode: 'new' }, { id: 'TRUCK-2', regionCode: 'NEW' },
        ]),
      },
      {
        route: '/api/resources/region-codes/NEW', method: 'PATCH', body: { revision: 3, code: 'next' },
        expected: () => golden.renameRegionCode(3, 'NEW', 'next'),
      },
    ];
    for (const mutation of mutations) {
      const response = await gatewayWrite(mutation.route, mutation.body, mutation.method);
      assert.equal(response.status, 200, mutation.route);
      assertKotlinOwner(response);
      assert.deepEqual(parsed(response), jsonValue(mutation.expected()), mutation.route);
    }
    const saved = parsed(await request(fixture.kotlinOrigin, '/api/resources'));
    assert.equal(saved.revision, 4);
    assert.equal(saved.regionCodes.some(item => item.code === 'NEW'), false);
    assert.equal(saved.regionCodes.some(item => item.code === 'NEXT'), true);
    assert.equal(saved.vehicles.filter(item => item.regionCode === 'NEXT').length, 2);
  });

  await t.test('stale revisions are rejected without changing the saved snapshot', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    const response = await gatewayWrite('/api/resources/vehicles/TRUCK-1', { revision: before.revision - 1, regionCode: null }, 'PATCH');
    assert.equal(response.status, 409);
    assert.equal(parsed(response).error, 'RESOURCE_REVISION_CONFLICT');
    assert.deepEqual(parsed(await request(fixture.origin, '/api/resources')), before);
  });

  await t.test('a failed bulk assignment rolls back every entry and its revision', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    const response = await gatewayWrite('/api/resources/vehicles', {
      revision: before.revision,
      assignments: [{ id: 'TRUCK-1', regionCode: 'Z001' }, { id: 'UNKNOWN', regionCode: null }],
    }, 'PATCH');
    assert.equal(response.status, 404);
    assert.equal(parsed(response).error, 'VEHICLE_NOT_FOUND');
    assert.deepEqual(parsed(await request(fixture.origin, '/api/resources')), before);
  });

  await t.test('two concurrent writes with one revision commit exactly once', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    const responses = await Promise.all([
      gatewayWrite('/api/resources/region-codes', { revision: before.revision, code: 'RACEA' }),
      gatewayWrite('/api/resources/region-codes', { revision: before.revision, code: 'RACEB' }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(parsed(responses.find(response => response.status === 409)).error, 'RESOURCE_REVISION_CONFLICT');
    const after = parsed(await request(fixture.origin, '/api/resources'));
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.regionCodes.filter(item => ['RACEA', 'RACEB'].includes(item.code)).length, 1);
  });

  await t.test('Kotlin restart preserves the SQLite revision and durable values', async () => {
    const before = parsed(await request(fixture.origin, '/api/resources'));
    await fixture.restartKotlin();
    const direct = await request(fixture.kotlinOrigin, '/api/resources');
    const gateway = await request(fixture.origin, '/api/resources');
    assert.equal(direct.status, 200);
    assert.equal(gateway.status, 200);
    assert.deepEqual(parsed(direct), before);
    assert.deepEqual(parsed(gateway), before);
  });

  await t.test('direct Node resource routes reject the moved owner without touching its database', async () => {
    const before = await fs.readFile(fixture.resourceDatabasePath);
    for (const [route, method, body] of [
      ['/api/resources', 'GET', undefined],
      ['/api/resources/region-codes', 'POST', JSON.stringify({ revision: 0, code: 'NODEWRITE' })],
      ['/api/resources/vehicles', 'PATCH', JSON.stringify({ revision: 0, assignments: [{ id: 'TRUCK-1', regionCode: null }] })],
    ]) {
      const response = await request(fixture.apiOrigin, route, {
        method,
        headers: body ? { origin: fixture.origin, 'content-type': 'application/json' } : {},
        body,
      });
      assert.equal(response.status, 503, `${method} ${route}`);
      assert.equal(parsed(response).error, 'RESOURCE_OWNER_MOVED');
      assert.equal(response.headers['x-meatbox-resource-owner'], 'kotlin');
    }
    assert.deepEqual(await fs.readFile(fixture.resourceDatabasePath), before);
  });

  await t.test('Kotlin outage returns an explicit gateway error without falling back to Node', async () => {
    await fixture.stopKotlin();
    const failed = await request(fixture.origin, '/api/resources');
    assert.equal(failed.status, 503);
    assert.deepEqual(parsed(failed), { error: 'KOTLIN_API_UNAVAILABLE' });
    assertKotlinOwner(failed);
    const node = await request(fixture.apiOrigin, '/api/resources');
    assert.equal(node.status, 503);
    assert.equal(parsed(node).error, 'RESOURCE_OWNER_MOVED');
  });

  await t.test('fixture closes both backends and removes the disposable registry', async () => {
    await fixture.close();
    await assert.rejects(fs.access(fixture.temporaryDirectory), { code: 'ENOENT' });
    for (const origin of [fixture.origin, fixture.apiOrigin, fixture.kotlinOrigin]) {
      await assert.rejects(requestRaw(origin, '/actuator/health'));
    }
  });
});
