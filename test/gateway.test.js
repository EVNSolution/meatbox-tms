const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createDemo, safeNext, validCommand } = require('../server');
const { createAccess } = require('../lib/access');

test('all branches, APIs and WebSocket require the same authenticated session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-gateway-'));
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ accessFile: path.join(dir, 'access.json'), origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  t.after(async () => { await demo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (url, data, cookie, requestOrigin = origin) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(data) });
  for (const route of ['/', '/scenario/', '/scenario/present', '/scenario/common.js', '/ui-layout/styles.css', '/combined/app.mjs', '/combined/']) {
    const res = await get(route); assert.equal(res.status, 302, route); assert.match(res.headers.get('location'), /^\/login\?next=/);
  }
  for (const route of ['/api/session', '/scenario/api/route-data']) assert.equal((await get(route)).status, 401, route);
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/dev/register')).status, 200);
  assert.equal((await post('/dev/register', {})).status, 400);
  const invite = await demo.access.issueInvite();
  const credentials = { username: 'reviewer', password: 'a-long-demo-password' };
  assert.equal((await post('/dev/register', { ...credentials, invite }, '', 'https://attacker.invalid')).status, 403);
  assert.equal((await post('/dev/register', { ...credentials, invite })).status, 303);
  assert.equal((await post('/dev/register', { ...credentials, username: 'second', invite })).status, 400);
  assert.equal((await post('/login', { ...credentials, password: 'wrong-password' })).status, 401);
  const login = await post('/login', { ...credentials, next: '//attacker.invalid' });
  assert.equal(login.status, 303); assert.equal(login.headers.get('location'), '/');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const home = await (await get('/', cookie)).text();
  for (const link of ['/scenario/', '/ui-layout/#/design', '/combined/']) assert.ok(home.includes(`href="${link}"`));
  assert.ok(!home.includes('/dev/register'));
  assert.equal((await get('/api/session', cookie)).status, 200);
  for (const route of ['/scenario/', '/scenario/customer', '/scenario/driver', '/scenario/control', '/scenario/present', '/ui-layout/', '/combined/']) assert.equal((await get(route, cookie)).status, 200, route);
  const scenarioResponse = await get('/scenario/customer', cookie);
  assert.equal(scenarioResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const scenario = await scenarioResponse.text();
  assert.ok(scenario.includes('src="/scenario/common.js"')); assert.ok(scenario.includes('/auth-check.js'));
  assert.equal((scenario.match(/integrity="sha384-/g) || []).length, 2);
  assert.equal((scenario.match(/crossorigin="anonymous"/g) || []).length, 2);
  const common = await (await get('/scenario/common.js', cookie)).text();
  assert.ok(common.includes('${location.host}/ws/simulation'));
  assert.ok(common.includes("fetch('/scenario/api/route-data')"));
  assert.equal((await get('/scenario/customer.html?id=S5', cookie)).headers.get('location'), '/scenario/customer?id=S5');
  assert.equal((await get('/ui-layout', cookie)).headers.get('location'), '/ui-layout/');
  for (const route of ['/server.js', '/lib/access.js', '/.runtime/access.json', '/workspaces/sanghyun-scenario/server.js']) assert.equal((await get(route, cookie)).status, 404, route);

  function denied(headers, endpoint = '/ws/simulation') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + endpoint, { headers });
      ws.once('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); resolve(); });
      ws.once('open', () => { ws.terminate(); reject(new Error('Unauthenticated websocket accepted')); });
      ws.on('error', () => {});
    });
  }
  await denied({ origin }); await denied({ cookie, origin: 'https://attacker.invalid' }); await denied({ cookie, origin }, '/');
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/simulation', { headers: { cookie, origin } });
  const first = await once(ws, 'message'); assert.equal(JSON.parse(first[0]).type, 'state');
  const nextState = once(ws, 'message'); ws.send(JSON.stringify({ type: 'place_order' }));
  assert.equal(JSON.parse((await nextState)[0]).state.phase, 'idle');
  assert.equal((await post('/logout', {}, cookie, 'https://attacker.invalid')).status, 403);
  const closed = once(ws, 'close'); assert.equal((await post('/logout', {}, cookie)).status, 303);
  assert.equal((await closed)[0], 4401);
  assert.equal((await get('/api/session', cookie)).status, 401);
  await denied({ cookie, origin });
});

test('production cookie secure and request redirects/commands are bounded', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-secure-'));
  const demo = createDemo({ accessFile: path.join(dir, 'access.json'), origin: 'https://3.36.96.156' });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await demo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const invite = await demo.access.issueInvite();
  await demo.access.register({ username: 'secureuser', password: 'test-secure-password', invite });
  const response = await fetch(`http://127.0.0.1:${demo.server.address().port}/login`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://3.36.96.156', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'secureuser', password: 'test-secure-password' }) });
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  for (const unsafe of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/login', '/dev/register', ['bad']]) assert.equal(safeNext(unsafe), '/');
  assert.equal(safeNext('/combined/#/customer'), '/combined/#/customer');
  assert.equal(validCommand({ type: 'speed', value: -10 }), false);
  assert.equal(validCommand({ type: 'speed', value: 20 }), true);
  assert.equal(validCommand({ type: 'reorder', stopId: 'S9', dir: 'up' }), false);
});

test('original owner snapshots remain byte-for-byte intact', async () => {
  const manifest = require('../docs/source-snapshots.json');
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const data = await fs.readFile(path.join(__dirname, '..', file));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), expected, file);
  }
});

test('a websocket stops receiving state as soon as its session expires', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-expiry-'));
  let now = Date.now();
  const access = createAccess({ file: path.join(dir, 'access.json'), now: () => now, sessionTtlMs: 1000 });
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ access, origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await demo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const invite = await access.issueInvite();
  await access.register({ username: 'expires', password: 'a-long-demo-password', invite });
  const { token } = await access.login({ username: 'expires', password: 'a-long-demo-password' });
  const ws = new WebSocket(`ws://127.0.0.1:${demo.server.address().port}/ws/simulation`, { headers: { origin, cookie: `meatbox_session=${token}` } });
  await once(ws, 'message');
  let messagesAfterExpiry = 0;
  ws.on('message', () => messagesAfterExpiry++);
  now += 1001;
  const closed = once(ws, 'close');
  demo.sim.emit();
  assert.equal((await closed)[0], 4401);
  assert.equal(messagesAfterExpiry, 0);
});
