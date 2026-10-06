const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createDemo, safeNext, validCommand } = require('../server');
const { createAccess } = require('../lib/access');
const { loginPage, registerPage } = require('../apps/portal/pages');

test('signup username pattern is valid in the browser Unicode sets mode', () => {
  const pattern = registerPage().match(/pattern="([^"]+)"/)[1];
  const validation = new RegExp(`^(?:${pattern})$`, 'v');
  assert.equal(validation.test('reviewer-01'), true);
  assert.equal(validation.test('_reviewer'), false);
  assert.equal(validation.test('검토자'), false);
});

test('auth forms expose native constraints and accessible inline validation targets', () => {
  const signup = registerPage();
  const login = loginPage();
  assert.match(signup, /data-validate/);
  assert.match(signup, /name="invite"[^>]*minlength="16"[^>]*maxlength="256"/);
  assert.match(signup, /name="password"[^>]*minlength="8"[^>]*maxlength="128"/);
  assert.equal((signup.match(/class="field-feedback"/g) || []).length, 4);
  assert.doesNotMatch(signup, /class="field-help"|class="field-error"/);
  assert.match(login, /name="username"[^>]*pattern=/);
  assert.match(login, /portal-validation\.js/);
  assert.match(login, /<h1>로그인<\/h1>/);
  assert.doesNotMatch(login, /데모 로그인|시연을 시작|팀 회의용 데모/);
  assert.match(login, /<img src="\/portal-logo\.svg"[^>]*alt="미트박스"/);
  assert.match(require('../apps/portal/pages').page('오류', '<h1>오류</h1><p>다시 시도해 주세요.</p>'), /class="auth-card auth-message"/);
});

test('authentication protects APIs while removed UI routes return gone', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-gateway-'));
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ accessFile: path.join(dir, 'access.json'), origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  t.after(async () => { await demo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (url, data, cookie, requestOrigin = origin) => fetch(base + url, {
    method: 'POST', redirect: 'manual',
    headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(data),
  });

  const removedRoutes = [
    '/', '/customer', '/driver?id=S5', '/control', '/present',
    '/scenario/', '/scenario/present', '/scenario/common.js',
    '/ui-layout/', '/ui-layout/styles.css', '/combined/', '/combined/app.mjs',
    '/combined/mobile-customer.html?id=S5', '/combined/driver.html',
  ];
  for (const route of removedRoutes) {
    const response = await get(route);
    assert.equal(response.status, 302, route);
    assert.match(response.headers.get('location'), /^\/login\?next=/);
  }
  for (const route of ['/api/session', '/scenario/api/route-data', '/api/dispatch-data/manifest', '/api/dispatch-data/regions']) {
    assert.equal((await get(route)).status, 401, route);
  }
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/dev/register')).status, 200);
  assert.equal((await get('/portal-validation.js')).status, 200);
  assert.equal((await get('/portal-logo.svg')).status, 200);
  assert.equal((await get('/portal-font.ttf')).status, 200);

  const invalidSignup = await post('/dev/register', {});
  assert.equal(invalidSignup.status, 400);
  const invalidSignupHtml = await invalidSignup.text();
  assert.match(invalidSignupHtml, /id="username-feedback"[^>]*aria-live="polite"[^>]*>영문 또는 숫자로 시작/);
  assert.doesNotMatch(invalidSignupHtml, /value="undefined"/);

  const invite = await demo.access.issueInvite();
  const credentials = { username: 'reviewer', password: 'demo1234' };
  assert.equal((await post('/dev/register', { ...credentials, invite }, '', 'https://attacker.invalid')).status, 403);
  assert.equal((await post('/dev/register', { ...credentials, invite })).status, 303);
  const reusedInvite = await post('/dev/register', { ...credentials, username: 'second', invite });
  assert.equal(reusedInvite.status, 400);
  const reusedInviteHtml = await reusedInvite.text();
  assert.match(reusedInviteHtml, /id="invite-feedback"[^>]*aria-live="polite"[^>]*>초대 코드가 유효하지 않거나 이미 사용/);
  assert.doesNotMatch(reusedInviteHtml, new RegExp(invite));
  assert.doesNotMatch(reusedInviteHtml, new RegExp(credentials.password));
  assert.equal((await post('/login', { ...credentials, password: 'wrong-password' })).status, 401);

  const login = await post('/login', { ...credentials, next: '//attacker.invalid' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await get('/api/session', cookie)).status, 200);
  for (const route of removedRoutes) {
    const response = await get(route, cookie);
    assert.equal(response.status, 410, route);
    assert.deepEqual(await response.json(), { error: 'UI_REMOVED' });
  }
  assert.equal((await get('/scenario/api/route-data', cookie)).status, 410);
  for (const route of ['/server.js', '/lib/access.js', '/.runtime/access.json', '/workspaces/sanghyun-scenario/server.js']) {
    assert.equal((await get(route, cookie)).status, 404, route);
  }

  function denied(headers, endpoint = '/ws/simulation') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + endpoint, { headers });
      ws.once('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401);
        res.resume();
        ws.terminate();
        resolve();
      });
      ws.once('open', () => { ws.terminate(); reject(new Error('Unauthenticated websocket accepted')); });
      ws.on('error', () => {});
    });
  }
  await denied({ origin });
  await denied({ cookie, origin: 'https://attacker.invalid' });
  await denied({ cookie, origin }, '/');

  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/simulation', { headers: { cookie, origin } });
  const first = await once(ws, 'message');
  assert.equal(JSON.parse(first[0]).type, 'state');
  async function commandState(command, matches) {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`No state for ${command.type}`)); }, 2000);
      function receive(raw) {
        const message = JSON.parse(raw);
        if (message.type === 'state' && matches(message.state)) {
          clearTimeout(timer);
          ws.off('message', receive);
          resolve(message.state);
        }
      }
      ws.on('message', receive);
    });
    ws.send(JSON.stringify(command));
    return result;
  }
  const shipping = await commandState({ type: 'set_scenario', scenario: 'shipping', stopId: 'S1' }, state => state.scenarioPreset === 'shipping');
  assert.equal(shipping.simClock, '06:30');
  const arrived = await commandState({ type: 'arrive_stop', stopId: 'S1' }, state => state.truck.dwelling && state.truck.fromId === 'S1');
  assert.ok(arrived.order[0].arrivedTime);
  const rejectedCompletion = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'complete_stop', stopId: 'S1' }));
  assert.deepEqual(JSON.parse((await rejectedCompletion)[0]), { type: 'error', error: 'COMPLETION_NOT_READY' });
  const completed = await commandState(
    { type: 'complete_stop', stopId: 'S1', confirmedRequestIds: ['S1-refrigerator'] },
    state => state.order[0].status === 'done',
  );
  assert.ok(completed.order[0].deliveredTime);
  const routeOrder = completed.order.map(stop => stop.id);
  [routeOrder[3], routeOrder[5]] = [routeOrder[5], routeOrder[3]];
  const routeRequest = {
    type: 'set_route_order', order: routeOrder,
    expectedOrder: completed.order.map(stop => stop.id),
    expectedStatuses: completed.order.map(stop => stop.status), expectedPhase: completed.phase,
  };
  assert.equal(validCommand(routeRequest), true);
  const reordered = await commandState(routeRequest, state => state.order[3].id === routeOrder[3]);
  assert.equal(reordered.order[0].status, 'done');
  assert.equal((await post('/logout', {}, cookie, 'https://attacker.invalid')).status, 403);
  const closed = once(ws, 'close');
  assert.equal((await post('/logout', {}, cookie)).status, 303);
  assert.equal((await closed)[0], 4401);
  assert.equal((await get('/api/session', cookie)).status, 401);
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
  assert.equal(validCommand({ type: 'advance' }), false);
  assert.equal(validCommand({ type: 'place_order' }), false);
  assert.equal(validCommand({ type: 'speed', value: -10 }), false);
  assert.equal(validCommand({ type: 'speed', value: 20 }), false);
  assert.equal(validCommand({ type: 'inject_traffic' }), false);
  assert.equal(validCommand({ type: 'inject_dwell' }), false);
  assert.equal(validCommand({ type: 'set_scenario', scenario: 'shipping', stopId: 'S1' }), true);
  assert.equal(validCommand({ type: 'reorder', stopId: 'S9', dir: 'up' }), false);
  assert.equal(validCommand({ type: 'complete_stop', stopId: 'S6', confirmedRequestIds: ['S6-indoor'] }), true);
  for (const confirmedRequestIds of [null, 'S1-refrigerator', [12], ['S9-doorstep'], ['S1-unknown'], ['S6-unknown'], Array(9).fill('S1-doorstep')]) {
    assert.equal(validCommand({ type: 'complete_stop', stopId: 'S1', confirmedRequestIds }), false);
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
