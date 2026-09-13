const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { createAccess, AccessError } = require('./lib/access');
const { page, loginPage, registerPage, homePage } = require('./apps/portal/pages');
const { Simulation } = require('./workspaces/sanghyun-scenario/src/simulation');
const routeData = require('./workspaces/sanghyun-scenario/src/route-data');

const COOKIE = 'meatbox_session';
const ROOT = __dirname;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
  if (['advance', 'place_order', 'reset', 'inject_traffic', 'inject_dwell', 'complete_stop'].includes(msg.type)) return true;
  if (msg.type === 'speed') return [1, 5, 20].includes(msg.value);
  if (['reorder', 'toggle_skip'].includes(msg.type)) return /^S[1-8]$/.test(msg.stopId) && (msg.type !== 'reorder' || ['up', 'down'].includes(msg.dir));
  return false;
}

function createDemo({ accessFile = process.env.ACCESS_FILE, origin = process.env.PUBLIC_ORIGIN, access = createAccess({ file: accessFile }) } = {}) {
  if (!origin || new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN must be an exact origin');
  const secure = new URL(origin).protocol === 'https:';
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Public access requires HTTPS');
  const app = express();
  app.enable('strict routing');
  app.set('query parser', 'simple');
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    // OSM tiles require a valid web Referer; cross-origin requests receive only our origin.
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://tile.openstreetmap.org https://cdnjs.cloudflare.com; connect-src 'self' ${origin.replace(/^http/, 'ws')}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
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
      res.status(400).send(registerPage('가입 정보를 확인해 주세요. 초대 코드는 유효 기간 내 한 번만 사용할 수 있습니다.'));
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
  for (const prefix of ['scenario', 'ui-layout', 'combined']) app.get(`/${prefix}`, (_req, res) => res.redirect(308, `/${prefix}/`));
  app.get('/', (req, res) => res.send(homePage(req.user)));
  app.get('/auth-check.js', (_req, res) => res.sendFile(path.join(ROOT, 'apps/portal/auth-check.js')));
  app.get('/scenario/api/route-data', (_req, res) => res.json(routeData));
  const scenarioDir = path.join(ROOT, 'workspaces/sanghyun-scenario/public');
  for (const view of ['', 'customer', 'driver', 'control', 'present']) {
    app.get(`/scenario/${view || 'index'}.html`, (req, res) => res.redirect(308, `/scenario/${view}${new URL(req.url, origin).search}`));
    app.get(`/scenario/${view}`, asyncRoute(async (_req, res) => {
      const html = await fs.readFile(path.join(scenarioDir, `${view || 'index'}.html`), 'utf8');
      res.type('html').send(html.replace(/(href|src)="\/(?!\/)/g, '$1="/scenario/')
        .replace('src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"', 'src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO" crossorigin="anonymous"')
        .replace('href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"', 'href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb" crossorigin="anonymous"')
        .replace('</body>', '<script src="/auth-check.js" defer></script></body>'));
    }));
  }
  app.get('/scenario/common.js', asyncRoute(async (_req, res) => {
    const js = await fs.readFile(path.join(scenarioDir, 'common.js'), 'utf8');
    res.type('js').send(js.replace('${location.host}`', '${location.host}/ws/simulation`').replace("fetch('/api/route-data')", "fetch('/scenario/api/route-data')").replace('ws.onclose = () => setTimeout(open, 1500);', "ws.onclose = async () => { try { const res = await fetch('/api/session'); if (res.status === 401) { location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; } } catch {} setTimeout(open, 1500); };"));
  }));
  app.use('/scenario', express.static(scenarioDir, { index: false, dotfiles: 'deny' }));
  app.get('/ui-layout/', asyncRoute(async (_req, res) => {
    const html = await fs.readFile(path.join(ROOT, 'workspaces/jiin-ui/index.html'), 'utf8');
    res.type('html').send(html.replace('</body>', '<script src="/auth-check.js" defer></script></body>'));
  }));
  app.use('/ui-layout', express.static(path.join(ROOT, 'workspaces/jiin-ui'), { index: false, dotfiles: 'deny' }));
  app.use('/combined', express.static(path.join(ROOT, 'apps/combined'), { dotfiles: 'deny' }));
  for (const view of ['customer', 'driver', 'control', 'present']) app.get(`/${view}`, (req, res) => res.redirect(308, `/scenario/${view}${new URL(req.url, origin).search}`));
  app.use((_req, res) => res.status(404).send(page('페이지 없음', '<h1>페이지를 찾을 수 없습니다.</h1><a href="/">작업 선택으로</a>')));
  app.use((error, _req, res, _next) => {
    console.error('Request failed:', error.name);
    res.status(error.status === 413 ? 413 : 500).send(page('요청 오류', '<h1>요청을 처리하지 못했습니다.</h1><a href="/">다시 시작하기</a>'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const boot = randomUUID();
  let latest;
  const sim = new Simulation(state => {
    latest = JSON.stringify({ type: 'state', state, boot });
    for (const ws of wss.clients) sendState(ws);
  });
  async function sendState(ws) {
    if (ws.readyState !== 1 || ws.checkingSession) return;
    ws.checkingSession = true;
    try {
      if (!await access.session(ws.token)) { ws.close(4401, 'Session ended'); return; }
      if (ws.readyState === 1) ws.send(latest);
    } catch { ws.close(1011, 'Session unavailable'); }
    finally { ws.checkingSession = false; }
  }
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
    let recent = [];
    ws.on('error', () => {});
    ws.on('message', async raw => {
      try {
        if (!await access.session(ws.token)) { ws.close(4401, 'Session ended'); return; }
        recent = recent.filter(ts => Date.now() - ts < 1000);
        if (recent.length >= 10) { ws.close(4429, 'Too many commands'); return; }
        recent.push(Date.now());
        const msg = JSON.parse(raw);
        if (!validCommand(msg)) return;
        switch (msg.type) {
          case 'advance': sim.advance(); break;
          case 'place_order': sim.placeOrder(); break;
          case 'reset': sim.reset(); break;
          case 'speed': sim.setSpeed(msg.value); break;
          case 'inject_traffic': sim.injectTraffic(); break;
          case 'inject_dwell': sim.injectDwell(); break;
          case 'reorder': sim.reorder(msg.stopId, msg.dir); break;
          case 'toggle_skip': sim.toggleSkip(msg.stopId); break;
          case 'complete_stop': sim.completeCurrentStop(); break;
        }
      } catch { ws.send(JSON.stringify({ type: 'error', error: 'INVALID_COMMAND' })); }
    });
  });
  const sweep = setInterval(async () => {
    for (const [key, item] of limits) if (item.until <= Date.now()) limits.delete(key);
    for (const ws of wss.clients) {
      ws.checkingSession = true;
      try { if (!await access.session(ws.token)) ws.close(4401, 'Session ended'); }
      catch { ws.close(1011, 'Session unavailable'); }
      finally { ws.checkingSession = false; }
    }
  }, 30_000);
  sweep.unref();
  async function close() {
    clearInterval(sweep); clearInterval(sim.timer);
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
