import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

class Element {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.children = [];
    this.cells = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  fire(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  insertCell() { const cell = new Element(); this.cells.push(cell); return cell; }
  insertRow() { const row = new Element(); this.children.push(row); return row; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  select() {}
  reset() {}
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('UI did not settle');
}

test('새 링크는 선택 배송에서 즉시 보이고 세션 오류·늦은 응답에서 지워진다', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const elements = new Map([...ids].map((id) => [id, new Element(id)]));
  for (const id of ['console-view', 'detail', 'detail-content', 'invite-box', 'create-wrap']) elements.get(id).hidden = true;
  const get = (id) => {
    assert.ok(ids.has(id), `missing real HTML id: ${id}`);
    return elements.get(id);
  };
  const previous = { document:globalThis.document, window:globalThis.window, fetch:globalThis.fetch };
  globalThis.document = { getElementById:get, createElement:() => new Element() };
  globalThis.window = { addEventListener() {} };
  const future = Date.now() + 3_600_000;
  const delivery = (id) => ({ id, userId:`test-${id}`, stage:'배송대기', revision:1, baselineAt:Date.now(), etaAt:null, expiresAt:future, activeSubscriptions:0 });
  const deliveries = [delivery('a'), delivery('b')];
  let denySession = false;
  let resolveRenew;
  let renewStarted = false;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'https://example.test').pathname;
    const ok = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (path.endsWith('/auth-mode')) return ok({ authMode:'tms' });
    if (path.endsWith('/session')) return ok({ csrfToken:'csrf', authMode:'tms', senderMode:'mock' });
    if (path.endsWith('/deliveries') && options.method === 'POST') {
      const created = delivery('c');
      deliveries.push(created);
      return ok({ delivery:created, invite:{ url:'https://example.test/push-lab/#invite=fresh-secret', expiresAt:future } }, 201);
    }
    if (path.endsWith('/deliveries')) {
      if (denySession) return ok({ error:'admin_session_required' }, 401);
      return ok({ deliveries, nextCursor:null });
    }
    if (path.endsWith('/deliveries/a/invitations')) {
      renewStarted = true;
      return new Promise((resolve) => { resolveRenew = resolve; });
    }
    if (path.endsWith('/deliveries/a') || path.endsWith('/deliveries/b') || path.endsWith('/deliveries/c')) {
      const id = path.split('/').at(-1);
      return ok({ delivery:deliveries.find((item) => item.id === id), subscriptions:[], outbox:[] });
    }
    return ok({ error:'not_found' }, 404);
  };
  try {
    await import(`./app.mjs?flow=${Date.now()}`);
    await until(() => !get('console-view').hidden && get('delivery-rows').children.length === 2);
    get('show-create').fire('click');
    get('user-id').value = 'test-c';
    get('expires-at').value = new Date(future - new Date(future).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await get('create-wrap').fire('submit');
    assert.equal(get('detail-title').textContent, 'test-c');
    assert.equal(get('invite-box').hidden, false);
    assert.equal(get('invite-url').value, 'https://example.test/push-lab/#invite=fresh-secret');
    assert.equal(get('invite-box').scrolled, true);
    assert.equal(get('copy-invite').focused, true);

    denySession = true;
    await get('refresh').fire('click');
    assert.equal(get('console-view').hidden, true);
    assert.equal(get('invite-box').hidden, true);
    assert.equal(get('invite-url').value, '');
    denySession = false;
    await get('retry-session').fire('click');
    await until(() => !get('console-view').hidden);
    await get('delivery-rows').children[0].cells[0].children[0].fire('click');
    assert.equal(get('detail-title').textContent, 'test-a');
    const renewal = get('renew-invite').fire('click');
    await until(() => renewStarted);
    await get('delivery-rows').children[1].cells[0].children[0].fire('click');
    resolveRenew(new Response(JSON.stringify({ invite:{ url:'https://example.test/push-lab/#invite=late-secret', expiresAt:future } }), { status:201 }));
    await renewal;
    assert.equal(get('invite-box').hidden, true);
    assert.equal(get('invite-url').value, '');
    assert.equal(get('detail-title').textContent, 'test-b');

  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
  }
});
