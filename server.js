const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createStateFrames } = require('./lib/state-frames');
const { createStateSender } = require('./lib/state-broadcast');
const { WebSocketServer } = require('ws');
const { createAccess, AccessError } = require('./lib/access');
const { createDispatchDataRouter } = require('./lib/dispatch-data');
const { createSourceOperationsRouter } = require('./lib/source-operations-router');
const { createResourceStore } = require('./lib/resource-store');
const { createResourceRouter } = require('./lib/resource-router');
const { calculateDispatch } = require('./lib/dispatch-calculator');
const { arriveStop, completeStop } = require('./lib/scenario-controls');
const { validRouteOrder, applyRouteOrder } = require('./lib/route-order');
const { page, loginPage, registerPage } = require('./apps/portal/pages');
const { OperatingSimulation, validPlainText } = require('./lib/operating-simulation');
const routeData = require('./workspaces/sanghyun-scenario/src/route-data');

const COOKIE = 'meatbox_session';
const ROOT = __dirname;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const withProductTitle = html => html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '<title>미트박스 TMS</title>');
function tokenFrom(req) {
  const matches = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : '';
}
function safeNext(value) {
  if (typeof value !== 'string' || /[\\\r\n]/.test(value)) return '/';
  try {
    const target = new URL(value, 'https://local.invalid');
    return target.origin === 'https://local.invalid' && /^\/(?:$|(?:scenario|ui-layout|combined)(?:\/|$))/.test(target.pathname)
      ? `${target.pathname}${target.search}${target.hash}` : '/';
  } catch { return '/'; }
}
function validCommand(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (msg.type === 'set_route_order') return validRouteOrder(msg);
  if (msg.type === 'reset') return true;
  if (msg.type === 'set_scenario') return ['received', 'picking', 'ready', 'shipping', 'arrived', 'completed'].includes(msg.scenario)
    && typeof msg.stopId === 'string' && /^S[1-8]$/.test(msg.stopId);
  if (['send_customer_notice', 'set_delivery_tip'].includes(msg.type)) {
    const max = msg.type === 'send_customer_notice' ? 300 : 500;
    return typeof msg.stopId === 'string' && /^(?:S[1-8]|V(?:[2-9]|[1-9]\d|1[0-2]\d|130)-S(?:[1-9]|[12]\d|3[0-5]))$/.test(msg.stopId)
      && validPlainText(msg.body, max);
  }
  if (msg.type === 'complete_stop') return (msg.stopId === undefined || /^S[1-8]$/.test(msg.stopId))
    && (msg.confirmedRequestIds === undefined || (Array.isArray(msg.confirmedRequestIds)
      && msg.confirmedRequestIds.length <= 8
      && msg.confirmedRequestIds.every(id => typeof id === 'string' && /^S[1-8]-(?:doorstep|refrigerator|indoor|handoff)$/.test(id))));
  if (msg.type === 'arrive_stop') return /^S[1-8]$/.test(msg.stopId);
  if (['reorder', 'toggle_skip'].includes(msg.type)) return /^S[1-8]$/.test(msg.stopId) && (msg.type !== 'reorder' || ['up', 'down'].includes(msg.dir));
  return false;
}

function createDemo({ accessFile = process.env.ACCESS_FILE, origin = process.env.PUBLIC_ORIGIN, access = createAccess({ file: accessFile }), dispatchDataDir = process.env.DISPATCH_DATA_DIR || path.join(ROOT, '.runtime/dispatch-data'), dispatchStateDir = process.env.DISPATCH_STATE_DIR || null, dispatchStateIO, dispatchCalculator = calculateDispatch, resourceDatabasePath = process.env.RESOURCE_DATABASE, now = Date.now } = {}) {
  if (!origin || new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN must be an exact origin');
  const secure = new URL(origin).protocol === 'https:';
  const resourceStore = resourceDatabasePath ? createResourceStore(resourceDatabasePath) : null;
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Public access requires HTTPS');
  const app = express();
  app.enable('strict routing');
  app.set('query parser', 'simple');
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    // OSM tiles require a valid web Referer; cross-origin requests receive only our origin.
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src 'self'; img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org https://cdnjs.cloudflare.com; connect-src 'self' https://tiles.openfreemap.org ${origin.replace(/^http/, 'ws')}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  const limits = new Map();
  function sameOrigin(req, res, next) {
    if (req.headers.origin !== origin) return res.status(403).send(page('요청 확인', '<h1>요청을 확인해 주세요.</h1><p>로그인 페이지에서 다시 시도해 주세요.</p><a href="/login">로그인으로</a>'));
    next();
  }
  function limitAccess(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    let item = limits.get(key);
    if (!item || item.until <= now) { item = { count: 0, until: now + 15 * 60_000 }; limits.set(key, item); }
    if (++item.count > 20) return res.status(429).set('Retry-After', String(Math.ceil((item.until - now) / 1000))).send(page('잠시 후 다시 시도', '<h1>잠시 후 다시 시도해 주세요.</h1><p>접근 요청이 많아 일시적으로 제한되었습니다.</p>'));
    next();
  }
  const cookieOptions = { secure, httpOnly: true, sameSite: 'strict', path: '/' };
  app.get('/portal.css', (_req, res) => res.sendFile(path.join(ROOT, 'apps/portal/portal.css')));
  app.get('/portal-logo.svg', (_req, res) => res.sendFile(path.join(ROOT, 'apps/combined/assets/meatbox-logo.svg')));
  app.get('/portal-font.ttf', (_req, res) => res.sendFile(path.join(ROOT, 'apps/combined/assets/PretendardVariable.ttf')));
  app.get('/portal-validation.js', (_req, res) => res.sendFile(path.join(ROOT, 'apps/portal/validation.js')));
  app.get('/login', asyncRoute(async (req, res) => {
    if (await access.session(tokenFrom(req))) return res.redirect(safeNext(req.query.next));
    res.send(loginPage({ next: safeNext(req.query.next), registered: req.query.registered === '1' }));
  }));
  app.post('/login', sameOrigin, limitAccess, asyncRoute(async (req, res) => {
    try {
      const result = await access.login(req.body);
      res.cookie(COOKIE, result.token, { ...cookieOptions, maxAge: Math.max(0, result.expiresAt - Date.now()) });
      res.redirect(303, safeNext(req.body.next));
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      res.status(401).send(loginPage({ next: safeNext(req.body.next), error: '아이디와 비밀번호를 확인해 주세요.' }));
    }
  }));
  app.get('/dev/register', (_req, res) => res.send(registerPage()));
  app.post('/dev/register', sameOrigin, limitAccess, asyncRoute(async (req, res) => {
    try {
      await access.register(req.body);
      res.redirect(303, '/login?registered=1');
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      const field = error.field || (error.code === 'USERNAME_TAKEN' ? 'username' : error.code === 'INVALID_INVITE' ? 'invite' : '');
      const message = error.code === 'USERNAME_TAKEN' ? '이미 사용 중인 아이디입니다.'
        : error.code === 'INVALID_INVITE' ? '초대 코드가 유효하지 않거나 이미 사용되었습니다.'
          : field === 'username' ? '영문 또는 숫자로 시작하는 3~40자로 입력해 주세요.'
            : field === 'password' ? '비밀번호를 8~128자로 입력해 주세요.'
              : field === 'displayName' ? '표시 이름은 제어 문자를 제외한 80자 이내로 입력해 주세요.'
                : '입력값을 확인해 주세요.';
      res.status(400).send(registerPage({
        errors: { [field || 'form']: message },
        values: { username: req.body.username, displayName: req.body.displayName },
      }));
    }
  }));
  app.post('/logout', sameOrigin, asyncRoute(async (req, res) => {
    const token = tokenFrom(req);
    await access.logout(token);
    for (const ws of wss.clients) if (ws.token === token) ws.close(4401, 'Session ended');
    res.clearCookie(COOKIE, cookieOptions).redirect(303, '/login');
  }));
  app.use(asyncRoute(async (req, res, next) => {
    req.user = await access.session(tokenFrom(req));
    if (req.user) return next();
    if (req.path.startsWith('/api/') || req.path.includes('/api/')) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    res.redirect(`/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
  }));
  app.get('/api/session', (req, res) => res.json({ user: req.user }));
  app.use('/api/resources', createResourceRouter({ store: resourceStore, origin }));
  app.use('/api/dispatch-data', createSourceOperationsRouter({ directory: dispatchDataDir, stateDirectory: dispatchStateDir, stateIO: dispatchStateIO, origin, calculator: dispatchCalculator, now }));
  app.use('/api/dispatch-data', createDispatchDataRouter({ directory: dispatchDataDir }));
  for (const prefix of ['scenario', 'ui-layout', 'combined']) app.get(`/${prefix}`, (_req, res) => res.redirect(308, `/${prefix}/`));
  app.get('/', (_req, res) => res.redirect(308, '/combined/'));
  app.get('/auth-check.js', (_req, res) => res.sendFile(path.join(ROOT, 'apps/portal/auth-check.js')));
  app.get('/scenario/api/route-data', (_req, res) => res.json(routeData));
  const scenarioDir = path.join(ROOT, 'workspaces/sanghyun-scenario/public');
  app.get(['/scenario/', '/scenario/index.html'], (req, res) => res.redirect(308, `/scenario/customer${new URL(req.url, origin).search}`));
  for (const view of ['customer', 'driver', 'control', 'present']) {
    app.get(`/scenario/${view}.html`, (req, res) => res.redirect(308, `/scenario/${view}${new URL(req.url, origin).search}`));
    app.get(`/scenario/${view}`, asyncRoute(async (_req, res) => {
      const html = await fs.readFile(path.join(scenarioDir, `${view}.html`), 'utf8');
      res.type('html').send(withProductTitle(html)
        .replace(/(href|src)="\/(?!\/)/g, '$1="/scenario/')
        .replace('src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"', 'src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO" crossorigin="anonymous"')
        .replace('href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"', 'href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb" crossorigin="anonymous"')
        .replace('</head>', '<style>#traffic,#dwell{display:none!important}</style></head>')
        .replace('</body>', '<script src="/auth-check.js" defer></script></body>'));
    }));
  }
  app.get('/scenario/common.js', asyncRoute(async (_req, res) => {
    const js = await fs.readFile(path.join(scenarioDir, 'common.js'), 'utf8');
    res.type('js').send(js.replace('${location.host}`', '${location.host}/ws/simulation`').replace("fetch('/api/route-data')", "fetch('/scenario/api/route-data')").replace('ws.onclose = () => setTimeout(open, 1500);', "ws.onclose = async () => { try { const res = await fetch('/api/session'); if (res.status === 401) { location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; } } catch {} setTimeout(open, 1500); };"));
  }));
  app.get('/scenario/driver.js', asyncRoute(async (_req, res) => {
    const js = await fs.readFile(path.join(scenarioDir, 'driver.js'), 'utf8');
    // Keep the reference source intact while routing completion through required proof.
    res.type('js').send(js
      .replace("const $ = (id) => document.getElementById(id);", "const $ = (id) => document.getElementById(id); let currentStopId = null;")
      .replace("MB.send('complete_stop')", "location.assign('/combined/driver.html?id=' + encodeURIComponent(currentStopId || 'S1'))")
      .replace("const current = s.order.find((o) => o.status === 'current');", "const current = s.order.find((o) => o.status === 'current'); currentStopId = current?.id; $('scan').textContent = '사진 확인 후 배송 완료';"));
  }));
  app.use('/scenario', express.static(scenarioDir, { index: false, dotfiles: 'deny' }));
  app.get(['/ui-layout/', '/ui-layout/index.html'], asyncRoute(async (_req, res) => {
    const html = await fs.readFile(path.join(ROOT, 'workspaces/jiin-ui/index.html'), 'utf8');
    res.type('html').send(withProductTitle(html)
      .replace('</head>', '<link rel="stylesheet" href="/combined/map-preview.css"></head>')
      .replace('</body>', '<script src="/auth-check.js" defer></script></body>'));
  }));
  app.get('/ui-layout/app.mjs', asyncRoute(async (_req, res) => {
    const js = await fs.readFile(path.join(ROOT, 'workspaces/jiin-ui/app.mjs'), 'utf8');
    res.type('js').send(js.replace('document.title = `${page.title} · 미트박스 TMS`;', "document.title = '미트박스 TMS';"));
  }));
  app.use('/ui-layout', express.static(path.join(ROOT, 'workspaces/jiin-ui'), { index: false, dotfiles: 'deny' }));
  app.use('/combined', express.static(path.join(ROOT, 'apps/combined'), { dotfiles: 'deny' }));
  for (const view of ['customer', 'driver', 'control', 'present']) app.get(`/${view}`, (req, res) => {
    const search = new URL(req.url, origin).search;
    const target = view === 'customer' ? `/combined/mobile-customer.html${search}`
      : view === 'driver' ? `/combined/driver.html${search}`
        : view === 'control' ? '/combined/#/control'
          : '/combined/';
    res.redirect(308, target);
  });
  app.use((_req, res) => res.status(404).send(page('페이지 없음', '<h1>페이지를 찾을 수 없습니다.</h1><a href="/combined/">운영 화면으로</a>')));
  app.use((error, _req, res, _next) => {
    console.error('Request failed:', error.name);
    res.status(error.status === 413 ? 413 : 500).send(page('요청 오류', '<h1>요청을 처리하지 못했습니다.</h1><a href="/">다시 시작하기</a>'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const commandWindows = new Map();
  const boot = randomUUID();
  const frames = createStateFrames(boot);
  const sendState = createStateSender({ latest: () => frames.latest, session: token => access.session(token) });
  const sim = new OperatingSimulation(state => {
    frames.publish(state);
    for (const ws of wss.clients) sendState(ws);
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (req.url !== '/ws/simulation' || req.headers.origin !== origin || !await access.session(tokenFrom(req))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, ws => { ws.token = tokenFrom(req); wss.emit('connection', ws); });
    } catch { socket.destroy(); }
  });
  wss.on('connection', ws => {
    sendState(ws);
    ws.on('error', () => {});
    ws.on('message', async raw => {
      try {
        const user = await access.session(ws.token);
        if (!user) { ws.close(4401, 'Session ended'); return; }
        const now = Date.now();
        const recent = (commandWindows.get(user.username) || []).filter(ts => now - ts < 1000);
        if (recent.length >= 10) { ws.close(4429, 'Too many commands'); return; }
        recent.push(now);
        commandWindows.set(user.username, recent);
        const msg = JSON.parse(raw);
        if (!validCommand(msg)) return;
        switch (msg.type) {
          case 'reset': sim.reset(); break;
          case 'set_scenario': sim.setScenario(msg.scenario, msg.stopId); break;
          case 'reorder': sim.reorder(msg.stopId, msg.dir); break;
          case 'set_route_order':
            if (!applyRouteOrder(sim, msg)) ws.send(JSON.stringify({ type: 'error', error: 'ROUTE_CHANGED' }));
            break;
          case 'toggle_skip': sim.toggleSkip(msg.stopId); break;
          case 'arrive_stop': arriveStop(sim, msg.stopId); break;
          case 'complete_stop':
            if (!completeStop(sim, msg.stopId, msg.confirmedRequestIds)) ws.send(JSON.stringify({ type: 'error', error: 'COMPLETION_NOT_READY' }));
            break;
          case 'send_customer_notice': sim.sendCustomerNotice(msg.stopId, msg.body, user.displayName); break;
          case 'set_delivery_tip': sim.setDeliveryTip(msg.stopId, msg.body); break;
        }
      } catch { ws.send(JSON.stringify({ type: 'error', error: 'INVALID_COMMAND' })); }
    });
  });
  const sweep = setInterval(async () => {
    const now = Date.now();
    for (const [key, item] of limits) if (item.until <= Date.now()) limits.delete(key);
    for (const [username, recent] of commandWindows) {
      const active = recent.filter(ts => now - ts < 1000);
      if (active.length) commandWindows.set(username, active);
      else commandWindows.delete(username);
    }
    for (const ws of wss.clients) {
      try { if (!await access.session(ws.token)) ws.close(4401, 'Session ended'); }
      catch { ws.close(1011, 'Session unavailable'); }
    }
  }, 30_000);
  sweep.unref();
  async function close() {
    clearInterval(sweep); clearInterval(sim.timer);
    resourceStore?.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  return { app, server, close, access, sim };
}
if (require.main === module) {
  const demo = createDemo();
  demo.server.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => console.log('Meatbox authenticated gateway ready'));
  process.on('SIGTERM', () => demo.close().then(() => process.exit(0)));
}
module.exports = { createDemo, safeNext, validCommand };
