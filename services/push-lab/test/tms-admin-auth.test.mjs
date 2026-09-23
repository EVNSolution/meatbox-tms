import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPushLabServer } from '../server/http.mjs';
import { TmsAdminAuth } from '../server/tms-admin-auth.mjs';
import { harness } from './helpers.mjs';

const ORIGIN = 'https://push-lab.example.test';
const token = () => randomBytes(32).toString('base64url');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function call(base, path, { method = 'GET', cookie, csrf, input, origin = ORIGIN } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (method !== 'GET') { headers.Origin = origin; headers['Content-Type'] = 'application/json'; }
  const response = await fetch(`${base}${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
  return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie() };
}

test('TMS mode grants only exact allowlisted live sessions and retains Origin/JSON/CSRF gates', async () => {
  const h = harness();
  const allowedToken = token();
  const deniedToken = token();
  const sessions = new Map([[allowedToken, 'operator1'], [deniedToken, 'otheruser']]);
  const seen = [];
  const tms = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, forwarded: req.headers['x-forwarded-for'] });
    const username = sessions.get(req.headers.cookie?.slice('meatbox_session='.length));
    res.setHeader('Content-Type', 'application/json');
    if (!username) { res.writeHead(401); res.end('{"error":"LOGIN_REQUIRED"}'); return; }
    res.end(JSON.stringify({ user: { username, displayName: username, createdAt: 1 } }));
  });
  const tmsBase = await listen(tms);
  const adapter = new TmsAdminAuth({ url: `${tmsBase}/api/session`, allowedUsernames: 'operator1', exchangeKeys: randomBytes(32).toString('base64') });
  const pilot = createPushLabServer({ db: h.db, service: h.service, origin: ORIGIN, adminAuthMode: 'tms_session', tmsAdminAuth: adapter });
  const base = `${await listen(pilot)}/push-lab/control/api`;
  try {
    assert.deepEqual(await call(base, '/auth-mode'), { status: 200, data: { authMode: 'tms' }, cookies: [] });
    assert.equal((await call(base, '/session')).status, 401);
    assert.equal((await call(base, '/session', { cookie: 'mb_push_admin_session=old' })).status, 401);
    const beforeMalformed = seen.length;
    assert.deepEqual(await call(base, '/session', { cookie: 'meatbox_session=%ZZ' }), { status: 401, data: { error: 'admin_session_required' }, cookies: [] });
    assert.equal((await call(base, '/deliveries', { method: 'POST', cookie: 'meatbox_session=%ZZ', csrf: 'bad', input: { userId: 'test-customer-01' } })).status, 401);
    assert.equal(seen.length, beforeMalformed);
    assert.equal((await call(base, '/session', { cookie: `meatbox_session=${deniedToken}` })).status, 403);
    const cookie = `meatbox_session=${allowedToken}; unrelated=%ZZ`;
    const session = await call(base, '/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.data.authMode, 'tms');
    assert.equal(session.data.expiresAt, null);
    assert.equal(session.data.senderMode, 'mock');
    assert.match(session.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.cookies.length, 0);
    assert.equal(seen.at(-1).cookie, `meatbox_session=${allowedToken}`);
    assert.equal(seen.at(-1).url, '/api/session');
    assert.equal(seen.at(-1).forwarded, undefined);
    assert.equal((await call(base, '/deliveries', { cookie })).status, 200);
    assert.equal((await call(base, '/deliveries', { method: 'POST', cookie, csrf: 'bad', input: { userId: 'test-customer-01' } })).status, 403);
    assert.equal((await call(base, '/deliveries', { method: 'POST', cookie, csrf: session.data.csrfToken, origin: 'https://wrong.test', input: { userId: 'test-customer-01' } })).status, 403);
    const plain = await fetch(`${base}/deliveries`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': session.data.csrfToken, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
    const created = await call(base, '/deliveries', { method: 'POST', cookie, csrf: session.data.csrfToken, input: { userId: 'test-customer-01' } });
    assert.equal(created.status, 201);
    assert.equal(created.cookies.length, 0);
    sessions.delete(allowedToken);
    assert.deepEqual(await call(base, '/session', { cookie }), { status: 401, data: { error: 'admin_session_required' }, cookies: [] });
    assert.equal((await call(base, '/deliveries', { cookie })).status, 401);
    assert.equal((await call(base, '/deliveries', { method: 'POST', cookie, csrf: session.data.csrfToken, input: { userId: 'test-customer-02' } })).status, 401);
    assert.equal(h.service.listAdminDeliveries({}).deliveries.length, 1);
    for (const path of ['/login-challenge', '/login', '/logout']) {
      assert.equal((await call(base, path, { method: path === '/login-challenge' ? 'GET' : 'POST', input: path === '/login-challenge' ? undefined : {} })).status, 404);
    }
  } finally { await close(pilot); await close(tms); h.close(); }
});

test('TMS cookie parser rejects duplicate, malformed and missing tokens without introspection', async () => {
  let calls = 0;
  const valid = token();
  const auth = new TmsAdminAuth({ url: 'http://127.0.0.1:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: randomBytes(32).toString('base64'),
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ user: { username: 'operator1' } }), { headers: { 'Content-Type': 'application/json' } }); } });
  const req = (cookie) => ({ rawHeaders: cookie ? ['Cookie', cookie] : [] });
  for (const cookie of [null, 'other=value', `meatbox_session=${valid}; meatbox_session=${valid}`, 'meatbox_session=bad', 'meatbox_session=%41'.repeat(22)]) {
    await assert.rejects(auth.session(req(cookie)), { status: 401, code: 'admin_session_required' });
  }
  assert.equal(calls, 0);
  assert.equal((await auth.session(req(`meatbox_session=${valid}`))).expiresAt, null);
  assert.equal(calls, 1);
});

test('TMS adapter fails closed for bad config, redirects, malformed data, timeout and overload', async () => {
  const key = randomBytes(32).toString('base64');
  const valid = token();
  const req = { rawHeaders: ['Cookie', `meatbox_session=${valid}`] };
  for (const config of [
    { url: 'http://example.com:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: key },
    { url: 'http://2130706433:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: key },
    { url: 'http://127.0.0.1:3001/api/session?x=1', allowedUsernames: 'operator1', exchangeKeys: key },
    { url: 'http://127.0.0.1:3001/api/session', allowedUsernames: '', exchangeKeys: key },
    { url: 'http://127.0.0.1:3001/api/session', allowedUsernames: '*', exchangeKeys: key },
    { url: 'http://127.0.0.1:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: '' },
  ]) await assert.rejects(new TmsAdminAuth(config).session(req), { status: 503, code: 'tms_auth_unavailable' });
  for (const response of [
    new Response(null, { status: 302, headers: { Location: '/login' } }),
    new Response('<html>wrong</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ user: { username: 'Operator1' } }), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const auth = new TmsAdminAuth({ url: 'http://127.0.0.1:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: key, fetchImpl: async () => response });
    await assert.rejects(auth.session(req), { status: 503, code: 'tms_auth_unavailable' });
  }
  const tms = createServer((_req, res) => { setTimeout(() => res.end('{}'), 100); });
  const url = `${await listen(tms)}/api/session`;
  try {
    const auth = new TmsAdminAuth({ url, allowedUsernames: 'operator1', exchangeKeys: key, timeoutMs: 10 });
    await assert.rejects(auth.session(req), { status: 503, code: 'tms_auth_unavailable' });
  } finally { await close(tms); }
  let release;
  const auth = new TmsAdminAuth({ url: 'http://127.0.0.1:3001/api/session', allowedUsernames: 'operator1', exchangeKeys: key, maxConcurrent: 1,
    fetchImpl: async () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ user: { username: 'operator1' } }), { headers: { 'Content-Type': 'application/json' } })); }) });
  const pending = auth.session(req);
  await assert.rejects(auth.session(req), { status: 503, code: 'tms_auth_unavailable' });
  release();
  assert.equal((await pending).expiresAt, null);
});
