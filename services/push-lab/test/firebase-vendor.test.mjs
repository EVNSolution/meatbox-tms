import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { createPushLabServer } from '../server/http.mjs';
import { harness } from './helpers.mjs';

const vendor = new URL('../public/vendor/', import.meta.url);

test('pinned Firebase browser ESM is local, hashed, and has no remote import', async () => {
  const files = await readdir(vendor);
  const app = files.filter(name => /^firebase-app\.[0-9a-f]{16}\.mjs$/.test(name));
  const messaging = files.filter(name => /^firebase-messaging\.[0-9a-f]{16}\.mjs$/.test(name));
  assert.equal(app.length, 1);
  assert.equal(messaging.length, 1);
  const loader = await readFile(new URL('firebase-vendor.mjs', vendor), 'utf8');
  const appSource = await readFile(new URL(app[0], vendor), 'utf8');
  const messagingSource = await readFile(new URL(messaging[0], vendor), 'utf8');
  assert.match(loader, new RegExp(`\\./${app[0].replaceAll('.', '\\.')}['"]`));
  assert.match(loader, new RegExp(`\\./${messaging[0].replaceAll('.', '\\.')}['"]`));
  assert.match(messagingSource, new RegExp(`from"\\./${app[0].replaceAll('.', '\\.')}"`));
  assert.doesNotMatch(messagingSource, /from"https?:\/\//);
  assert.doesNotMatch(appSource, /(?:import|export)[^;]*from\s*["']https?:\/\//);
  assert.doesNotMatch(loader, /gstatic|https?:\/\//);
});

test('CSP permits only the Firebase endpoints used at runtime and no third-party script', async () => {
  const serverSource = await readFile(new URL('../server/http.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /script-src 'self';/);
  assert.doesNotMatch(serverSource, /script-src[^;]*gstatic/);
  assert.match(serverSource, /connect-src 'self' https:\/\/firebaseinstallations\.googleapis\.com https:\/\/fcmregistrations\.googleapis\.com;/);
  assert.doesNotMatch(serverSource, /https:\/\/\*\.googleapis\.com|https:\/\/\*\.google\.com/);
});

test('hashed Firebase vendor modules are served locally with no-cache CSP', async () => {
  const h = harness();
  const server = createPushLabServer({ db:h.db, service:h.service, origin:'https://push.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const files = (await readdir(vendor)).filter(name => name.endsWith('.mjs'));
    for (const name of files) {
      const response = await fetch(`${base}/push-lab/vendor/${name}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type'), /text\/javascript/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src[^;]*gstatic/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.close();
  }
});
