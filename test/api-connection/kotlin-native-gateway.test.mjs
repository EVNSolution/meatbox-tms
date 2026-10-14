import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
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

function request(origin, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const framedHeaders = body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) };
    const outgoing = http.request(new URL(route, origin), { method, headers: framedHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Native gateway fixture request timeout')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function json(response) {
  return JSON.parse(response.body.toString('utf8'));
}

function rejectedUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'meatbox-state-v2', { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Removed native WebSocket rejection timed out'));
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
      reject(new Error('Removed native WebSocket unexpectedly opened'));
    });
    socket.once('error', error => {
      if (!String(error.message).includes('Unexpected server response')) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

test('native gateway remains usable after the legacy Node backend is removed', { timeout: 90_000 }, async t => {
  const [apiPort, webPort, kotlinPort] = await availablePorts();
  const fixture = await startForkFixture({ native: true, apiPort, webPort, kotlinPort });
  t.after(() => fixture.close());
  await assert.rejects(request(fixture.apiOrigin, '/api/session'), { code: 'ECONNREFUSED' });
  await fixture.stopLegacy();

  let cookie;
  const get = (route, headers = {}) => request(fixture.origin, route, { headers: { cookie, ...headers } });

  await t.test('authenticates and serves the operating UI without the legacy backend', async () => {
    const login = await request(fixture.origin, '/login', {
      method: 'POST',
      headers: { origin: fixture.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'fork-reviewer', password: 'local-fork-1234', next: '/combined/' }).toString(),
    });
    assert.equal(login.status, 303);
    cookie = login.headers['set-cookie'][0].split(';', 1)[0];
    const session = await get('/api/session');
    assert.equal(session.status, 200);
    assert.equal(json(session).user.username, 'fork-reviewer');
    for (const route of ['/combined/', '/ui-layout/']) {
      const page = await get(route);
      assert.equal(page.status, 200, route);
      assert.match(page.headers['content-type'], /^text\/html/);
    }
  });

  await t.test('routes source, dispatch, and resource reads only to Kotlin', async () => {
    for (const [route, marker] of [
      ['/api/dispatch-data/manifest', ['x-meatbox-source-reader', 'kotlin']],
      [`/api/dispatch-data/days/${fixture.today}/state`, ['x-meatbox-dispatch-owner', 'kotlin']],
      ['/api/resources', ['x-meatbox-resource-owner', 'kotlin']],
    ]) {
      const response = await get(route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers[marker[0]], marker[1], route);
    }
  });

  await t.test('returns 410 for removed demo pages and the simulation WebSocket', async () => {
    for (const route of [
      '/scenario/', '/scenario/customer', '/scenario/present', '/scenario/common.js', '/scenario/api/route-data',
      '/customer', '/driver', '/present', '/combined/driver.html', '/combined/mobile-customer.html',
    ]) {
      const response = await get(route);
      assert.equal(response.status, 410, route);
      assert.match(response.body.toString('utf8'), /Old demo removed/);
    }
    const status = await rejectedUpgrade(`${fixture.origin.replace('http:', 'ws:')}/ws/simulation`, { cookie, origin: fixture.origin });
    assert.equal(status, 410);
  });

  await t.test('protects driver tokens and persists two-way messages through the Kotlin gateway', async () => {
    const base = `/api/dispatch-data/days/${fixture.today}`;
    const call = (route, method, body, headers = {}) => request(fixture.origin, route, {
      method,
      headers: { cookie, origin: fixture.origin, 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let state = json(await get(`${base}/state`));
    for (const command of [
      { type: 'calculate_dispatch', vehicleIds: ['TRUCK-1'] },
      { type: 'publish_dispatch' },
    ]) {
      const response = await call(`${base}/commands`, 'POST', {
        ...command, expectedBoot: state.boot, expectedRevision: state.revision,
        ...(command.type === 'publish_dispatch' ? { draftVersion: state.dispatch.draftVersion } : {}),
      });
      assert.equal(response.status, 200, response.body.toString());
      state = json(response).state;
    }
    const messages = `${base}/driver/messages`;
    const tokens = `${base}/driver/push-token`;
    const tokenBody = { vehicleId: 'TRUCK-1', token: 'synthetic-device-token-never-deliver', platform: 'android', deviceId: 'fixture-device' };
    for (const [route, method, body] of [
      [`${messages}?vehicleId=TRUCK-1`, 'GET'],
      [tokens, 'PUT', tokenBody],
      [tokens, 'DELETE', { token: tokenBody.token }],
      [messages, 'POST', { vehicleId: 'TRUCK-1', from: 'ops', body: '합성 메시지' }],
    ]) {
      const denied = await call(route, method, body, { cookie: '' });
      assert.equal(denied.status, 401, `${method} ${route}`);
      assert.equal(denied.headers['x-meatbox-dispatch-owner'], 'kotlin');
    }
    for (const [route, method, body] of [
      [tokens, 'PUT', tokenBody],
      [tokens, 'DELETE', { token: tokenBody.token }],
      [messages, 'POST', { vehicleId: 'TRUCK-1', from: 'ops', body: '합성 메시지' }],
    ]) {
      assert.equal((await call(route, method, body, { origin: 'https://wrong.invalid' })).status, 403);
    }
    assert.ok([200, 204].includes((await call(tokens, 'PUT', tokenBody)).status));
    for (const from of ['ops', 'driver']) {
      const saved = await call(messages, 'POST', { vehicleId: 'TRUCK-1', from, body: `${from} 합성 메시지` });
      assert.equal(saved.status, 200, saved.body.toString());
      const value = json(saved);
      assert.equal(value.message.from, from);
      assert.ok(value.message.id);
      assert.ok(['unconfigured', 'no-device', 'not-requested'].includes(value.push.status));
    }
    const listed = await get(`${messages}?vehicleId=TRUCK-1`);
    assert.equal(listed.status, 200);
    assert.deepEqual(json(listed).messages.map(message => message.from), ['ops', 'driver']);
    assert.ok(!listed.body.toString().includes(tokenBody.token), 'device tokens stay private');
    assert.equal((await call(messages, 'POST', { vehicleId: 'TRUCK-1', from: 'ops', body: ' ' })).status, 400);
    assert.equal((await call(messages, 'POST', { vehicleId: 'TRUCK-1', from: 'ops', body: 'x'.repeat(1001) })).status, 400);
    assert.ok([200, 204].includes((await call(tokens, 'DELETE', { token: tokenBody.token })).status));
  });

  await t.test('returns Kotlin 404 for unknown APIs instead of falling back to Node', async () => {
    const response = await get('/api/legacy-only-unknown');
    assert.equal(response.status, 404);
  });

  await t.test('returns 503 without Node fallback when Kotlin stops', async () => {
    await fixture.stopKotlin();
    for (const route of ['/api/session', '/api/dispatch-data/manifest', `/api/dispatch-data/days/${fixture.today}/state`, '/api/resources']) {
      const response = await get(route);
      assert.equal(response.status, 503, route);
      assert.deepEqual(json(response), { error: 'KOTLIN_API_UNAVAILABLE' }, route);
    }
    assert.equal((await get('/combined/')).status, 503);
  });
});
