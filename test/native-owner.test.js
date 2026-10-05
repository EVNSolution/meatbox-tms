'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createDemo} = require('../server');
const {createKotlinAccess} = require('../lib/kotlin-access');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('native ownership closes Node account and dispatch endpoints without opening absent stores', async t => {
  let requests = 0;
  const owner = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/api/session');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({user: {username: 'review-user', displayName: '검토자', createdAt: 1}}));
  });
  const kotlinApiOrigin = await listen(owner);
  t.after(() => owner.close());
  const demo = createDemo({
    origin: 'http://127.0.0.1:4173', kotlinApiOrigin,
    accessFile: '/unavailable/account.json', dispatchDataDir: '/unavailable/source', dispatchStateDir: '/unavailable/state',
    resourceDatabasePath: '/unavailable/resources.sqlite', authOwner: 'kotlin', dispatchOwner: 'kotlin', resourceOwner: 'kotlin',
  });
  t.after(() => demo.close());
  const origin = await listen(demo.server);
  for (const route of ['/api/session', '/login', '/dev/register', '/logout']) {
    const response = await fetch(origin + route, {method: route === '/api/session' ? 'GET' : 'POST'});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-meatbox-auth-owner'), 'kotlin');
    assert.equal((await response.json()).error, 'AUTH_OWNER_MOVED');
  }
  assert.equal(requests, 0);
  for (const boundary of ['state', 'commands']) {
    const response = await fetch(`${origin}/api/dispatch-data/days/2026-10-05/${boundary}`, {
      method: boundary === 'state' ? 'GET' : 'POST', headers: {cookie: 'meatbox_session=' + 'a'.repeat(43)},
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-meatbox-dispatch-owner'), 'kotlin');
    assert.equal((await response.json()).error, 'DISPATCH_OWNER_MOVED');
  }
  assert.equal(requests, 2);
});

test('transitional Node session consumer rejects missing, malformed and oversized Kotlin identity', async t => {
  let mode = 'valid';
  const owner = http.createServer((_req, res) => {
    if (mode === 'unauthorized') { res.writeHead(401); res.end(); return; }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(mode === 'oversized' ? ' '.repeat(16385) : JSON.stringify({user: {username: mode === 'invalid' ? 123 : 'review-user'}}));
  });
  const origin = await listen(owner);
  t.after(() => owner.close());
  const access = createKotlinAccess(origin);
  assert.equal(await access.session('short'), null);
  const token = 'a'.repeat(43);
  assert.equal((await access.session(token)).username, 'review-user');
  mode = 'unauthorized';
  assert.equal(await access.session(token), null);
  for (mode of ['invalid', 'oversized']) {
    await assert.rejects(access.session(token), {code: 'KOTLIN_SESSION_UNAVAILABLE', status: 503});
  }
  assert.throws(() => createKotlinAccess('https://remote.invalid'));
});
