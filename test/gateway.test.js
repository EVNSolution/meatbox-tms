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
});

test('all branches, APIs and WebSocket require the same authenticated session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-gateway-'));
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ accessFile: path.join(dir, 'access.json'), origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  t.after(async () => { await demo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (url, data, cookie, requestOrigin = origin) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(data) });
  for (const route of ['/', '/scenario/', '/scenario/present', '/scenario/common.js', '/ui-layout/styles.css', '/combined/app.mjs', '/combined/', '/combined/mobile-customer.html?id=S5', '/combined/mobile-customer.css', '/combined/map-preview.css', '/combined/demo-shell.mjs', '/combined/simulation-client.mjs', '/combined/driver.html', '/combined/driver.mjs', '/combined/assets/meatbox-logo.svg']) {
    const res = await get(route); assert.equal(res.status, 302, route); assert.match(res.headers.get('location'), /^\/login\?next=/);
  }
  for (const route of ['/api/session', '/scenario/api/route-data', '/api/dispatch-data/manifest', '/api/dispatch-data/destinations?date=2026-09-17', '/api/dispatch-data/regions', '/api/dispatch-data/days/2025-09-12']) assert.equal((await get(route)).status, 401, route);
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/dev/register')).status, 200);
  const validator = await get('/portal-validation.js');
  assert.equal(validator.status, 200);
  assert.match(validator.headers.get('content-type'), /javascript/);
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
  const duplicateInvite = await demo.access.issueInvite();
  const duplicate = await post('/dev/register', { ...credentials, invite: duplicateInvite });
  assert.equal(duplicate.status, 400);
  const duplicateHtml = await duplicate.text();
  assert.match(duplicateHtml, /id="username-feedback"[^>]*aria-live="polite"[^>]*>이미 사용 중인 아이디/);
  assert.doesNotMatch(duplicateHtml, new RegExp(duplicateInvite));
  assert.doesNotMatch(duplicateHtml, new RegExp(credentials.password));
  assert.equal((await post('/login', { ...credentials, password: 'wrong-password' })).status, 401);
  const login = await post('/login', { ...credentials, next: '//attacker.invalid' });
  assert.equal(login.status, 303); assert.equal(login.headers.get('location'), '/');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const root = await get('/', cookie);
  assert.equal(root.status, 308);
  assert.equal(root.headers.get('location'), '/combined/');
  assert.equal((await get('/api/session', cookie)).status, 200);
  for (const route of ['/ui-layout/', '/combined/']) assert.equal((await get(route, cookie)).status, 200, route);
  const scenarioEntries = {
    '/scenario/': '/scenario/customer',
    '/scenario/index.html?id=S5': '/scenario/customer?id=S5',
    '/scenario/customer.html?id=S5': '/scenario/customer?id=S5',
  };
  for (const [route, location] of Object.entries(scenarioEntries)) {
    const response = await get(route, cookie);
    assert.equal(response.status, 308, route);
    assert.equal(response.headers.get('location'), location, route);
  }
  const combinedAliases = {
    '/customer?id=S5': '/combined/mobile-customer.html?id=S5',
    '/driver?id=S5': '/combined/driver.html?id=S5',
    '/control': '/combined/#/control',
    '/present': '/combined/',
  };
  for (const [route, location] of Object.entries(combinedAliases)) {
    const response = await get(route, cookie);
    assert.equal(response.status, 308, route);
    assert.equal(response.headers.get('location'), location, route);
  }
  for (const view of ['customer', 'driver', 'control', 'present']) {
    const response = await get(`/scenario/${view}`, cookie);
    assert.equal(response.status, 200, view);
    const html = await response.text();
    assert.match(html, /<title>미트박스 TMS<\/title>/);
    assert.match(html, new RegExp(`src="/scenario/${view}\\.js"`));
    assert.match(html, /src="\/scenario\/common\.js"/);
    assert.match(html, /src="\/auth-check\.js" defer/);
    assert.match(html, /#traffic,#dwell\{display:none!important\}/);
    if (['customer', 'control'].includes(view)) {
      assert.equal((html.match(/integrity="sha384-/g) || []).length, 2, view);
      assert.equal((html.match(/crossorigin="anonymous"/g) || []).length, 2, view);
    }
  }
  const common = await (await get('/scenario/common.js', cookie)).text();
  assert.ok(common.includes('${location.host}/ws/simulation'));
  assert.ok(common.includes("fetch('/scenario/api/route-data')"));
  const referenceDriver = await (await get('/scenario/driver.js', cookie)).text();
  assert.doesNotMatch(referenceDriver, /MB\.send\('complete_stop'\)/);
  assert.match(referenceDriver, /location\.assign\('\/combined\/driver\.html\?id='/);
  assert.match(referenceDriver, /currentStopId = current\?\.id/);
  assert.match(referenceDriver, /사진 확인 후 배송 완료/);
  const combined = await (await get('/combined/', cookie)).text();
  assert.match(combined, /<title>미트박스 TMS<\/title>/);
  const shell = await (await get('/combined/demo-shell.mjs', cookie)).text();
  assert.match(shell, /class="demo-brand"/);
  assert.match(shell, /class="operator-pages"/);
  assert.doesNotMatch(shell, /data-viewer="(?:operator|customer|driver)"|viewer-source-context/);
  assert.match(combined, /data-page="orders"/);
  assert.doesNotMatch(combined, /data-page="manage"/);
  assert.match(combined, /id="vehicle-control"/);
  const controlModule = await (await get('/combined/vehicle-control.mjs', cookie)).text();
  assert.match(controlModule, /data-control-tab="management"/);
  for (const asset of ['/combined/vehicle-control.css', '/combined/vehicle-operations-model.mjs', '/combined/resource-management.mjs', '/combined/resource-management.css']) assert.equal((await get(asset, cookie)).status, 200, asset);
  for (const asset of ['/combined/route-editor.mjs', '/combined/operations.css', '/combined/operations-model.mjs', '/combined/order-planning.css', '/combined/order-planning.mjs', '/combined/brand.css', '/combined/assets/meatbox-logo.svg', '/combined/assets/meatbox-app.webp', '/combined/driver.html']) assert.equal((await get(asset, cookie)).status, 200, asset);
  assert.doesNotMatch(combined, /href="\/ui-layout\/#\/design"/);
  assert.match(combined, /href="\.\/order-planning\.css"/);
  assert.match(combined, /id="order-planning"/);
  assert.doesNotMatch(combined, /map-preview|monitor-map-toggle|monitor-map-preview/);
  const layout = await (await get('/ui-layout/', cookie)).text();
  assert.match(layout, /<title>미트박스 TMS<\/title>/);
  assert.match(await (await get('/ui-layout/index.html', cookie)).text(), /<title>미트박스 TMS<\/title>/);
  const layoutApp = await (await get('/ui-layout/app.mjs', cookie)).text();
  assert.match(layoutApp, /document\.title = '미트박스 TMS';/);
  assert.doesNotMatch(layoutApp, /document\.title = `\$\{page\.title\}/);
  assert.match(layout, /href="\/combined\/map-preview\.css"/);
  const referenceAuth = await (await get('/auth-check.js', cookie)).text();
  assert.match(referenceAuth, /home\.href = '\/combined\/'/);
  assert.match(referenceAuth, /운영 화면으로/);
  assert.doesNotMatch(referenceAuth, /작업 선택/);
  const mapCss = await get('/combined/map-preview.css', cookie);
  assert.equal(mapCss.status, 200);
  assert.match(mapCss.headers.get('content-type'), /text\/css/);
  const mobileResponse = await get('/combined/mobile-customer.html?id=S5', cookie);
  assert.equal(mobileResponse.status, 200);
  assert.equal(mobileResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const mobile = await mobileResponse.text();
  assert.match(mobile, /<title>미트박스 TMS<\/title>/);
  for (const script of ['./mobile-customer-links.mjs', '/auth-check.js']) assert.ok(mobile.includes(`src="${script}"`), script);
  assert.doesNotMatch(mobile, /src="\/scenario\/common\.js"/);
  assert.match(mobile, /assets\/vendor\/maplibre\/maplibre-gl-csp\.js/);
  assert.doesNotMatch(mobile, /leaflet/);
  const policy = mobileResponse.headers.get('content-security-policy');
  assert.match(policy, /worker-src 'self';/);
  assert.match(policy, /connect-src 'self' https:\/\/tiles\.openfreemap\.org /);
  assert.doesNotMatch(policy, /unsafe-eval|worker-src[^;]*blob:|connect-src[^;]*\*/);
  for (const asset of ['app-viewer.css', 'assets/maps/dsv-korea-v1.json', 'assets/vendor/maplibre/maplibre-gl-csp-worker.js']) {
    assert.equal((await get(`/combined/${asset}`)).status, 302, asset);
    assert.equal((await get(`/combined/${asset}`, cookie)).status, 200, asset);
  }
  const customerEntry = await (await get('/combined/mobile-customer-links.mjs', cookie)).text();
  assert.match(customerEntry, /from '\.\/customer-renderer\.mjs'/);
  assert.equal((customerEntry.match(/connectSimulation\(/g) || []).length, 1);
  assert.doesNotMatch(customerEntry, /\/scenario\/customer\.js/);
  assert.equal((await get('/combined/customer-renderer.mjs', cookie)).status, 200);
  assert.match(await (await get('/combined/driver.html', cookie)).text(), /<title>미트박스 TMS<\/title>/);
  const mobileCss = await get('/combined/mobile-customer.css', cookie);
  assert.equal(mobileCss.status, 200);
  assert.match(mobileCss.headers.get('content-type'), /text\/css/);
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
  async function commandState(command, matches) {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`No state for ${command.type}`)); }, 2000);
      function receive(raw) {
        const message = JSON.parse(raw);
        if (message.type === 'state' && matches(message.state)) {
          clearTimeout(timer); ws.off('message', receive); resolve(message.state);
        }
      }
      ws.on('message', receive);
    });
    ws.send(JSON.stringify(command));
    return result;
  }
  const shipping = await commandState({ type: 'set_scenario', scenario: 'shipping', stopId: 'S1' }, state => state.scenarioPreset === 'shipping' && state.scenarioStopId === 'S1');
  assert.equal(shipping.simClock, '06:30');
  const arrived = await commandState({ type: 'arrive_stop', stopId: 'S1' }, state => state.truck.dwelling && state.truck.fromId === 'S1');
  assert.ok(arrived.order[0].arrivedTime);
  assert.equal(arrived.order[0].deliveredTime, null);
  const rejectedCompletion = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'complete_stop', stopId: 'S1' }));
  assert.deepEqual(JSON.parse((await rejectedCompletion)[0]), { type: 'error', error: 'COMPLETION_NOT_READY' });
  assert.equal(demo.sim.snapshot().order[0].deliveredTime, null);
  const completed = await commandState({ type: 'complete_stop', stopId: 'S1', confirmedRequestIds: ['S1-refrigerator'] }, state => state.order[0].status === 'done');
  assert.ok(completed.order[0].deliveredTime);
  assert.equal(completed.truck.toId, 'S2');
  const routeOrder = completed.order.map(stop => stop.id);
  [routeOrder[3], routeOrder[5]] = [routeOrder[5], routeOrder[3]];
  const routeRequest = { type: 'set_route_order', order: routeOrder, expectedOrder: completed.order.map(stop => stop.id), expectedStatuses: completed.order.map(stop => stop.status), expectedPhase: completed.phase };
  assert.equal(validCommand(routeRequest), true);
  const reordered = await commandState(routeRequest, state => state.order[3].id === routeOrder[3]);
  assert.equal(reordered.order[0].status, 'done');
  assert.equal(reordered.truck.toId, 'S2');
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
