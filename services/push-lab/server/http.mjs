import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.mjs';
import { SCHEMA_VERSION } from './db.mjs';
import { validateExchangeKeys } from './crypto.mjs';
import { AdminAuth } from './admin-auth.mjs';
import { TmsAdminAuth } from './tms-admin-auth.mjs';

const SESSION_COOKIE = 'mb_push_session';
const INSTALLATION_COOKIE = 'mb_push_installation';
const ADMIN_SESSION_COOKIE = 'mb_push_admin_session';
const ADMIN_LOGIN_COOKIE = 'mb_push_admin_login_csrf';
const CLIENT_IP_HEADER = 'x-push-lab-client-ip';
const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; connect-src 'self' https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'],
  ['.ttf', 'font/ttf'], ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

function cookies(header = '') {
  return Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((item) => item.length === 2));
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}; Path=/push-lab/; Secure; HttpOnly; SameSite=Lax`;
}

function adminCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}; Path=/push-lab/control/; Secure; HttpOnly; SameSite=Strict`;
}

function mappedIpv4(address) {
  return address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function trustedPeers(value) {
  if (!value) return new Set();
  const peers = value.split(',').map((item) => item.trim());
  if (peers.some((peer) => !isIP(peer))) throw new Error('PUSH_LAB_TRUSTED_PROXY_PEERS must contain exact IP addresses');
  return new Set(peers.map(mappedIpv4));
}

function loginSource(req, peers) {
  const peer = req.socket.remoteAddress;
  if (!peers.has(mappedIpv4(peer))) return peer;
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === CLIENT_IP_HEADER) values.push(req.rawHeaders[index + 1]);
  }
  if (values.length !== 1 || values[0].length > 45 || /[\s,%]/.test(values[0]) || !isIP(values[0])) {
    throw new ApiError(400, 'client_ip_invalid');
  }
  return mappedIpv4(values[0]);
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new ApiError(413, 'body_too_large');
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function staticFile(pathname, method, res) {
  if (!['GET', 'HEAD'].includes(method) || !(pathname === '/push-lab' || pathname.startsWith('/push-lab/'))) return false;
  let relative;
  try { relative = decodeURIComponent(pathname.slice('/push-lab'.length)); } catch { throw new ApiError(400, 'invalid_path'); }
  if (relative === '' || relative === '/') relative = '/index.html';
  const path = resolve(PUBLIC_ROOT, `.${relative}`);
  if (!(path === PUBLIC_ROOT || path.startsWith(`${PUBLIC_ROOT}${sep}`))) throw new ApiError(404, 'not_found');
  let content;
  try { content = await readFile(path); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
  res.writeHead(200, {
    'Content-Type': TYPES.get(extname(path)) || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : content);
  return true;
}

async function controlStaticFile(pathname, method, res) {
  if (!['GET', 'HEAD'].includes(method)) return false;
  const files = new Map([
    ['/push-lab/control', 'index.html'], ['/push-lab/control/', 'index.html'],
    ['/push-lab/control/index.html', 'index.html'], ['/push-lab/control/app.mjs', 'app.mjs'],
    ['/push-lab/control/styles.css', 'styles.css'], ['/push-lab/control/model.mjs', 'model.mjs'],
  ]);
  const file = files.get(pathname);
  if (!file) return false;
  let content;
  try { content = await readFile(resolve(PUBLIC_ROOT, 'control', file)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  res.writeHead(200, {
    'Content-Type': TYPES.get(extname(file)), 'Content-Length': content.length,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : content);
  return true;
}

export function createPushLabServer({
  db,
  service,
  adminAuth = new AdminAuth(db),
  tmsAdminAuth = new TmsAdminAuth(),
  adminAuthMode = process.env.PUSH_LAB_ADMIN_AUTH_MODE || 'password',
  origin = process.env.ALLOWED_ORIGIN,
  trustedProxyPeers = process.env.PUSH_LAB_TRUSTED_PROXY_PEERS || '',
  buildSha = process.env.BUILD_SHA || 'dev',
  slot = process.env.SLOT || 'local',
  logger = console,
  requestTimeoutMs = 25_000,
  headersTimeoutMs = 20_000,
  keepAliveTimeoutMs = 5_000,
}) {
  if (!['password', 'tms_session'].includes(adminAuthMode)) throw new Error('PUSH_LAB_ADMIN_AUTH_MODE must be password or tms_session');
  const tmsMode = adminAuthMode === 'tms_session';
  const peers = trustedPeers(trustedProxyPeers);
  let draining = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://push-lab.local');
      const method = req.method || 'GET';
      if ((url.pathname === '/healthz' || url.pathname === '/push-lab/healthz') && method === 'GET') return send(res, 200, { ok: true });
      if ((url.pathname === '/readyz' || url.pathname === '/push-lab/readyz') && method === 'GET') {
        if (draining || !origin || !validateExchangeKeys()) return send(res, 503, { ready: false });
        try {
          const schema = db.prepare('SELECT max(version) AS version FROM schema_meta').get().version;
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE schema_meta SET applied_at=applied_at WHERE version=?').run(schema);
          } finally {
            db.exec('ROLLBACK');
          }
          return send(res, schema === SCHEMA_VERSION ? 200 : 503, { ready: schema === SCHEMA_VERSION, buildSha, slot, schema });
        } catch {
          try { db.exec('ROLLBACK'); } catch {}
          return send(res, 503, { ready: false });
        }
      }
      if (url.pathname === '/push-lab/api/config' && method === 'GET') {
        return send(res, 200, {
          senderMode: process.env.PUSH_LAB_SENDER_MODE === 'real' ? 'real' : 'mock',
          firebase: {
            apiKey: process.env.FIREBASE_API_KEY || '',
            authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
            projectId: process.env.FIREBASE_PROJECT_ID || '',
            appId: process.env.FIREBASE_APP_ID || '',
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
            vapidKey: process.env.FIREBASE_VAPID_PUBLIC_KEY || '',
          },
          selfTestDelaySeconds: service.selfTestDelayMs / 1000,
        });
      }

      if (url.pathname.startsWith('/push-lab/control/api/')) {
        const path = url.pathname.slice('/push-lab/control/api'.length);
        if (path === '/auth-mode' && method === 'GET') return send(res, 200, { authMode: tmsMode ? 'tms' : 'password' });
        if (tmsMode && ['/login-challenge', '/login', '/logout'].includes(path)) return send(res, 404, { error: 'not_found' });
        const jar = tmsMode ? {} : cookies(req.headers.cookie);
        const csrf = req.headers['x-csrf-token'];
        if (path === '/login-challenge' && method === 'GET') {
          const challenge = adminAuth.challenge();
          return send(res, 200, { csrfToken: challenge.csrfToken },
            { 'Set-Cookie': adminCookie(ADMIN_LOGIN_COOKIE, challenge.csrfToken, challenge.expiresAt - Date.now()) });
        }
        if (path === '/login' && method === 'POST') {
          if (!origin || req.headers.origin !== origin) throw new ApiError(403, 'origin_invalid');
          if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'content_type_invalid');
          const input = await body(req);
          const result = adminAuth.login({ password: input.password, cookieToken: jar[ADMIN_LOGIN_COOKIE], headerToken: csrf, source: loginSource(req, peers) });
          return send(res, 200, { authenticated: true, csrfToken: result.csrfToken, expiresAt: result.expiresAt, authMode: 'password', senderMode: process.env.PUSH_LAB_SENDER_MODE === 'real' ? 'real' : 'mock' },
            { 'Set-Cookie': [adminCookie(ADMIN_SESSION_COOKIE, result.sessionToken, result.expiresAt - Date.now()), adminCookie(ADMIN_LOGIN_COOKIE, '', 0)] });
        }
        const adminToken = jar[ADMIN_SESSION_COOKIE];
        if (path === '/session' && method === 'GET') {
          const session = tmsMode ? await tmsAdminAuth.session(req) : adminAuth.session(adminToken);
          return send(res, 200, { authenticated: true, ...session, authMode: tmsMode ? 'tms' : 'password', senderMode: process.env.PUSH_LAB_SENDER_MODE === 'real' ? 'real' : 'mock' });
        }
        if (method === 'GET') {
          if (tmsMode) await tmsAdminAuth.session(req);
          else adminAuth.session(adminToken);
        }
        else {
          if (!origin || req.headers.origin !== origin) throw new ApiError(403, 'origin_invalid');
          if (tmsMode) await tmsAdminAuth.mutation(req, csrf);
          else adminAuth.mutation(adminToken, csrf);
          if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'content_type_invalid');
        }
        if (path === '/logout' && method === 'POST') {
          adminAuth.logout(adminToken, csrf);
          return send(res, 200, { authenticated: false }, { 'Set-Cookie': adminCookie(ADMIN_SESSION_COOKIE, '', 0) });
        }
        if (path === '/deliveries' && method === 'GET') {
          return send(res, 200, service.listAdminDeliveries({ limit: url.searchParams.get('limit') ?? 50, cursor: url.searchParams.get('cursor') }));
        }
        if (path === '/deliveries' && method === 'POST') return send(res, 201, service.createAdminDelivery(await body(req), origin));
        const match = /^\/deliveries\/([^/]+)(?:\/(invitations|stage|test-notifications))?$/.exec(path);
        if (match) {
          let deliveryId;
          try { deliveryId = decodeURIComponent(match[1]); } catch { throw new ApiError(400, 'invalid_path'); }
          if (!match[2] && method === 'GET') return send(res, 200, service.getAdminDelivery(deliveryId));
          if (match[2] === 'invitations' && method === 'POST') return send(res, 201, service.reissueAdminInvitation(deliveryId, origin));
          if (match[2] === 'stage' && method === 'POST') return send(res, 200, service.advanceAdminStage(deliveryId, await body(req)));
          if (match[2] === 'test-notifications' && method === 'POST') return send(res, 202, service.enqueueAdminTest(deliveryId, await body(req)));
        }
        return send(res, 404, { error: 'not_found' });
      }

      if (url.pathname === '/push-lab/control' || url.pathname.startsWith('/push-lab/control/')) {
        if (await controlStaticFile(url.pathname, method, res)) return;
        return send(res, 404, { error: 'not_found' });
      }

      if (!['GET', 'HEAD'].includes(method)) {
        if (!origin || req.headers.origin !== origin) throw new ApiError(403, 'origin_invalid');
      }
      const jar = cookies(req.headers.cookie);
      const csrf = req.headers['x-csrf-token'];
      if (url.pathname === '/push-lab/api/session' && method === 'GET') {
        return send(res, 200, service.restoreSession(jar[SESSION_COOKIE]));
      }
      if (url.pathname === '/push-lab/api/session/exchange' && method === 'POST') {
        const input = await body(req);
        const result = service.exchangeInvite({ ...input, sessionToken: jar[SESSION_COOKIE] });
        return send(res, 200, {
          csrfToken: result.csrfToken,
          sessionExpiresAt: result.sessionExpiresAt,
          deliveryIds: result.deliveryIds,
        }, { 'Set-Cookie': cookie(SESSION_COOKIE, result.sessionToken, result.sessionExpiresAt - Date.now()) });
      }
      if (url.pathname === '/push-lab/api/registration' && method === 'PUT') {
        const result = service.registerInstallation(jar[SESSION_COOKIE], csrf, jar[INSTALLATION_COOKIE], await body(req));
        return send(res, 200, {
          installationId: result.installationId,
          fidVersion: result.fidVersion,
          active: result.active,
        }, { 'Set-Cookie': cookie(INSTALLATION_COOKIE, result.proofToken, 365 * 86_400_000) });
      }
      const deliveryMatch = url.pathname.match(/^\/push-lab\/api\/deliveries\/([^/]+)$/);
      if (deliveryMatch && method === 'GET') return send(res, 200, service.getDelivery(jar[SESSION_COOKIE], decodeURIComponent(deliveryMatch[1]), jar[INSTALLATION_COOKIE]));
      const subscriptionMatch = url.pathname.match(/^\/push-lab\/api\/deliveries\/([^/]+)\/subscription$/);
      if (subscriptionMatch && method === 'PUT') {
        const input = await body(req);
        return send(res, 200, service.subscribe(jar[SESSION_COOKIE], csrf, jar[INSTALLATION_COOKIE], decodeURIComponent(subscriptionMatch[1]), input.consentVersion));
      }
      if (subscriptionMatch && method === 'DELETE') {
        return send(res, 200, service.unsubscribe(jar[SESSION_COOKIE], csrf, jar[INSTALLATION_COOKIE], decodeURIComponent(subscriptionMatch[1])));
      }
      const selfTestMatch = url.pathname.match(/^\/push-lab\/api\/deliveries\/([^/]+)\/self-test$/);
      if (selfTestMatch && method === 'POST') {
        const input = await body(req);
        return send(res, 202, service.enqueueSelfTest(jar[SESSION_COOKIE], csrf, jar[INSTALLATION_COOKIE], decodeURIComponent(selfTestMatch[1]), input.idempotencyKey));
      }
      if (await staticFile(url.pathname, method, res)) return;
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ApiError) return send(res, error.status, { error: error.code });
      logger.error(error);
      send(res, 500, { error: 'internal_error' });
    }
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.beginDrain = () => { draining = true; };
  return server;
}
