import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const origin = 'https://demo.meatbox.co.kr';
const secureLink = `${origin}/push-lab/#invite=invite-1`;
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));

function browser(startUrl, { standalone = false, fullscreen = false, session = false, configured = false, configFails = false, configHangs = false, client = 'safari', exchangeError = '', deliveryExpired = false, deliverable = true, permission = 'default' } = {}) {
  const elements = new Map();
  const requests = [];
  const intervals = new Map();
  let current = new URL(startUrl);
  let permissionRequests = 0;
  let registrations = 0;
  const element = id => {
    if (!htmlIds.has(id)) throw new Error(`missing HTML element: ${id}`);
    if (!elements.has(id)) elements.set(id, {
      hidden:['delivery-view', 'eta-card'].includes(id), disabled:false, checked:false, value:'', textContent:'', innerHTML:'', style:{}, dataset:{},
      listeners:{}, addEventListener(type, listener) { this.listeners[type] = listener; }, replaceChildren() {},
    });
    return elements.get(id);
  };
  globalThis.document = { getElementById:element, addEventListener() {}, hidden:false };
  globalThis.window = globalThis;
  globalThis.location = {
    get href() { return current.href; }, get hash() { return current.hash; }, get pathname() { return current.pathname; },
    get search() { return current.search; }, get origin() { return current.origin; },
  };
  globalThis.history = { replaceState(_state, _title, path) { current = new URL(path, current); } };
  globalThis.matchMedia = query => ({ matches:query.includes('fullscreen') ? fullscreen : standalone });
  globalThis.isSecureContext = true;
  globalThis.Notification = { permission, requestPermission:() => { permissionRequests += 1; return Promise.resolve('denied'); } };
  globalThis.PushManager = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{
    userAgent:`Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 ${client === 'chrome' ? 'CriOS/120.0 Safari/604.1' : client === 'webview' ? 'Instagram/300.0' : 'Version/17.0 Safari/604.1'}`,
    platform:'iPhone', maxTouchPoints:5,
    serviceWorker:{ register:async () => { registrations += 1; throw new Error('unexpected registration'); } },
  } });
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem:key => storage.get(key) || null, setItem:(key, value) => storage.set(key, value), removeItem:key => storage.delete(key),
  };
  globalThis.setInterval = callback => { const id = intervals.size + 1; intervals.set(id, callback); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, method:options.method || 'GET' });
    if (path.endsWith('/session') && !session) return { ok:false, status:401, json:async () => ({ error:'session_required' }) };
    if (path.endsWith('/session/exchange') && exchangeError) return { ok:false, status:410, json:async () => ({ error:exchangeError }) };
    if (path.endsWith('/session') || path.endsWith('/session/exchange')) return { ok:true, json:async () => ({ csrfToken:'csrf', deliveryIds:['delivery-1'], sessionExpiresAt:Date.now() + 60_000 }) };
    if (path.endsWith('/config') && configHangs) return new Promise(() => {});
    if (path.endsWith('/config') && configFails) return { ok:false, status:503, json:async () => ({ error:'config_unavailable' }) };
    if (path.endsWith('/config')) return { ok:true, json:async () => ({
      firebase:configured ? { apiKey:'key', projectId:'project', appId:'app', messagingSenderId:'sender', vapidKey:'vapid' } : null,
      senderMode:'mock',
    }) };
    if (path.endsWith('/deliveries/delivery-1') && deliveryExpired) return { ok:false, status:410, json:async () => ({ error:'delivery_expired' }) };
    if (path.endsWith('/deliveries/delivery-1')) return { ok:true, json:async () => ({ delivery:{ id:'delivery-1', stage:'배송대기', deliverable }, subscription:null }) };
    throw new Error(`unexpected request: ${path}`);
  };
  return {
    element, requests, url:() => current.href, permissionRequests:() => permissionRequests, registrations:() => registrations,
    tick:() => { for (const callback of [...intervals.values()]) callback(); },
    count:suffix => requests.filter(request => request.path.endsWith(suffix)).length,
  };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('iPhone Safari 보안 링크는 설치 단계 없이 즉시 조회하고 fragment를 지운다', async () => {
  const ui = browser(secureLink);
  await import('./app.mjs?simple=safari');
  await settle();
  assert.equal(ui.url(), `${origin}/push-lab/?delivery=delivery-1`);
  assert.equal(ui.count('/session/exchange'), 1);
  assert.equal(ui.element('delivery-view').hidden, false);
  assert.equal(ui.element('consent-row').hidden, true);
  assert.equal(ui.element('subscribe').hidden, true);
  assert.equal(ui.element('unsubscribe').hidden, true);
  assert.equal(ui.permissionRequests(), 0);
  assert.equal(ui.registrations(), 0);
});

test('Chrome iOS와 앱 내 브라우저에서도 보안 링크는 즉시 교환한다', async () => {
  for (const client of ['chrome', 'webview']) {
    const ui = browser(secureLink, { client });
    await import(`./app.mjs?simple=${client}`);
    await settle();
    assert.equal(ui.count('/session/exchange'), 1);
    assert.equal(ui.element('delivery-view').hidden, false);
    assert.equal(ui.registrations(), 0);
  }
});

test('iOS fullscreen에서는 기능이 있으면 신청을 보이고 권한은 클릭에서만 요청한다', async () => {
  const ui = browser(`${origin}/push-lab/`, { session:true, configured:true, fullscreen:true });
  await import('./app.mjs?simple=fullscreen');
  await settle();
  assert.equal(ui.element('consent-row').hidden, false);
  assert.equal(ui.element('subscribe').hidden, false);
  assert.equal(ui.permissionRequests(), 0);
  ui.element('consent').checked = true;
  ui.element('consent').listeners.change();
  assert.equal(ui.element('subscribe').disabled, false);
  const click = ui.element('subscribe').listeners.click();
  assert.equal(ui.permissionRequests(), 1);
  await click;
  assert.equal(ui.registrations(), 0);
});

test('설정 조회 실패는 배송 조회와 polling을 막지 않는다', async () => {
  const ui = browser(secureLink, { configFails:true, fullscreen:true });
  await import('./app.mjs?simple=config-failure');
  await settle();
  assert.equal(ui.element('delivery-view').hidden, false);
  assert.match(ui.element('provider-message').textContent, /설정/);
  ui.tick();
  await settle();
  assert.equal(ui.count('/deliveries/delivery-1'), 2);
  assert.equal(ui.element('subscribe').disabled, true);
  const safari = browser(secureLink, { configFails:true });
  await import('./app.mjs?simple=config-failure-safari');
  await settle();
  assert.equal(safari.element('delivery-view').hidden, false);
  assert.match(safari.element('provider-message').textContent, /알림 설정/);
});

test('설정 응답이 끝나지 않아도 배송 polling은 시작한다', async () => {
  const ui = browser(secureLink, { configHangs:true, fullscreen:true });
  await import('./app.mjs?simple=config-pending');
  await settle();
  assert.equal(ui.element('delivery-view').hidden, false);
  ui.tick();
  await settle();
  assert.equal(ui.count('/deliveries/delivery-1'), 2);
  assert.equal(ui.element('subscribe').disabled, true);
});

test('권한 거부와 발송 제외 배송은 알림 신청을 노출하지 않는다', async () => {
  for (const [name, options] of [
    ['denied', { permission:'denied' }],
    ['probe', { deliverable:false }],
  ]) {
    const ui = browser(secureLink, { fullscreen:true, configured:true, ...options });
    await import(`./app.mjs?simple=${name}`);
    await settle();
    assert.equal(ui.element('delivery-view').hidden, false);
    assert.equal(ui.element('consent-row').hidden, true);
    assert.equal(ui.element('subscribe').hidden, true);
    assert.equal(ui.permissionRequests(), 0);
    assert.equal(ui.registrations(), 0);
  }
});

test('만료된 배송은 세션을 임의로 닫지 않고 새 링크 필요를 알린다', async () => {
  const ui = browser(secureLink, { deliveryExpired:true });
  await import('./app.mjs?simple=delivery-expired');
  await settle();
  assert.equal(ui.element('delivery-view').hidden, false);
  assert.match(ui.element('status-note').textContent, /새 보안 링크/);
});

test('링크 없음·잘못된 링크·만료된 링크는 새 보안 링크를 요청한다', async () => {
  const cases = [
    [`${origin}/push-lab/`, { session:false }, 'missing'],
    [`${origin}/push-lab/?invite=secret#invite=invite-1`, {}, 'invalid'],
    [secureLink, { exchangeError:'invalid_invite' }, 'expired'],
  ];
  for (const [url, options, name] of cases) {
    const ui = browser(url, options);
    await import(`./app.mjs?simple=${name}`);
    await settle();
    assert.match(ui.element('invite-message').textContent, /새 보안 링크/);
    assert.equal(ui.element('delivery-view').hidden, true);
  }
});

test('고객 화면에는 설치 게이트, 코드 입력, 자가 발송 버튼과 빈 상품·위치 카드가 없다', async () => {
  for (const marker of ['install-gate', 'invite-form', 'self-test', 'map-card', 'order-card', 'customer-device']) {
    assert.doesNotMatch(html, new RegExp(`id="${marker}"|class="${marker}"`));
  }
});
