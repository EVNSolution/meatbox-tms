import assert from 'node:assert/strict';
import test from 'node:test';

const origin = 'https://demo.meatbox.co.kr';
const secureLink = `${origin}/push-lab/#invite=invite-1`;

function browser(startUrl, { standalone = false, session = false, configured = false, client = 'safari' } = {}) {
  const elements = new Map();
  const requests = [];
  const copies = [];
  let current = new URL(startUrl);
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden:['invite-form', 'install-gate', 'delivery-view', 'install-message'].includes(id), disabled:false, checked:false, value:'', textContent:'', innerHTML:'', style:{}, dataset:{},
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
  globalThis.matchMedia = () => ({ matches:standalone });
  globalThis.isSecureContext = true;
  globalThis.Notification = { permission:'default', requestPermission:async () => { throw new Error('unexpected permission prompt'); } };
  globalThis.PushManager = class {};
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{
    userAgent:`Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 ${client === 'chrome' ? 'CriOS/120.0 Safari/604.1' : client === 'webview' ? 'Instagram/300.0' : 'Version/17.0 Safari/604.1'}`,
    platform:'iPhone', maxTouchPoints:5, serviceWorker:{},
    clipboard:{ writeText:async value => { copies.push(value); } },
  } });
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem:key => storage.get(key) || null, setItem:(key, value) => storage.set(key, value), removeItem:key => storage.delete(key),
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async path => {
    requests.push(path);
    if (path.endsWith('/session') && !session) return { ok:false, status:401, json:async () => ({ error:'session_required' }) };
    if (path.endsWith('/session') || path.endsWith('/session/exchange')) return { ok:true, json:async () => ({ csrfToken:'csrf', deliveryIds:['delivery-1'], sessionExpiresAt:Date.now() + 60_000 }) };
    if (path.endsWith('/config')) return { ok:true, json:async () => ({
      firebase:configured ? { apiKey:'key', projectId:'project', appId:'app', messagingSenderId:'sender', vapidKey:'vapid' } : null,
      senderMode:'mock',
    }) };
    if (path.endsWith('/deliveries/delivery-1')) return { ok:true, json:async () => ({ delivery:{ id:'delivery-1', stage:'배송대기', deliverable:true }, subscription:null }) };
    throw new Error(`unexpected request: ${path}`);
  };
  return { element, requests, copies, url:() => current.href };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('iPhone Safari 초대는 복사나 명시적 계속 전까지 소비하지 않는다', async () => {
  const ui = browser(secureLink);
  await import('./app.mjs?onboarding=safari');
  assert.equal(ui.url(), `${origin}/push-lab/`);
  assert.equal(ui.element('install-gate').hidden, false);
  assert.equal(ui.element('invite-form').hidden, true);
  assert.deepEqual(ui.requests, []);
  assert.deepEqual(ui.copies, []);
  await ui.element('copy-invite').listeners.click();
  assert.deepEqual(ui.copies, [secureLink]);
  assert.deepEqual(ui.requests, []);
  ui.element('continue-browser').listeners.click();
  await settle();
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 1);
  assert.equal(ui.element('delivery-view').hidden, false);
  assert.match(ui.element('install-message').textContent, /홈 화면에 추가/);
  assert.match(ui.element('provider-message').textContent, /설정이 없어/);
  assert.equal(ui.element('consent').disabled, false);
  ui.element('consent').checked = true;
  ui.element('consent').listeners.change();
  assert.equal(ui.element('subscribe').disabled, true);
  assert.equal(ui.element('self-test').disabled, true);
});

test('URLSearchParams.size가 없는 iOS에서도 발급 링크를 설치 안내로 보낸다', async () => {
  const NativeParams = globalThis.URLSearchParams;
  globalThis.URLSearchParams = class extends NativeParams { get size() { return undefined; } };
  try {
    const ui = browser(secureLink);
    await import('./app.mjs?onboarding=no-param-size');
    assert.equal(ui.element('install-gate').hidden, false);
    assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  } finally {
    globalThis.URLSearchParams = NativeParams;
  }
});

test('설치된 앱은 같은 출처의 전체 링크를 한 번 교환하고 입력을 비운다', async () => {
  const ui = browser(`${origin}/push-lab/`, { standalone:true });
  await import('./app.mjs?onboarding=installed');
  await settle();
  assert.equal(ui.element('invite-form').hidden, false);
  ui.element('invite-code').value = secureLink;
  ui.element('invite-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(ui.element('invite-code').value, '');
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 1);
  assert.equal(ui.element('delivery-view').hidden, false);
});

test('Safari에 직접 붙여 넣은 링크는 설치 안내를 거친다', async () => {
  const ui = browser(`${origin}/push-lab/`);
  await import('./app.mjs?onboarding=manual');
  await settle();
  ui.element('invite-code').value = secureLink;
  ui.element('invite-form').listeners.submit({ preventDefault() {} });
  assert.equal(ui.element('invite-code').value, '');
  assert.equal(ui.element('install-gate').hidden, false);
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  await ui.element('copy-invite').listeners.click();
  assert.deepEqual(ui.copies, [secureLink]);
});

test('Safari에 직접 붙여 넣은 코드도 설치 안내에서 명시적으로 복사한다', async () => {
  const ui = browser(`${origin}/push-lab/`);
  await import('./app.mjs?onboarding=manual-code');
  await settle();
  ui.element('invite-code').value = 'invite-1';
  ui.element('invite-form').listeners.submit({ preventDefault() {} });
  assert.equal(ui.element('install-gate').hidden, false);
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  assert.deepEqual(ui.copies, []);
  await ui.element('copy-invite').listeners.click();
  assert.deepEqual(ui.copies, ['invite-1']);
});

test('iPhone Chrome와 앱 내 브라우저도 새 링크를 자동 소비하지 않는다', async () => {
  for (const client of ['chrome', 'webview']) {
    const ui = browser(secureLink, { client });
    await import(`./app.mjs?onboarding=${client}`);
    assert.equal(ui.element('install-gate').hidden, false);
    assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  }
});

test('다른 출처 링크는 설치 앱에서도 교환하지 않는다', async () => {
  const ui = browser(`${origin}/push-lab/`, { standalone:true });
  await import('./app.mjs?onboarding=foreign');
  await settle();
  ui.element('invite-code').value = 'https://other.example/push-lab/#invite=invite-1';
  ui.element('invite-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  assert.match(ui.element('invite-message').textContent, /올바른 TEST 초대/);
});

test('기존 Safari 세션은 배송을 계속 보여 주고 설치·설정 누락을 함께 안내한다', async () => {
  const ui = browser(`${origin}/push-lab/`, { session:true });
  await import('./app.mjs?onboarding=restored');
  await settle();
  assert.equal(ui.element('delivery-view').hidden, false);
  assert.equal(ui.element('install-message').hidden, false);
  assert.match(ui.element('support-message').textContent, /홈 화면에 추가/);
  assert.match(ui.element('provider-message').textContent, /설정이 없어/);
  assert.equal(ui.element('consent').disabled, false);
  assert.equal(ui.element('subscribe').disabled, true);
});

test('설치 앱의 모의 발송 환경은 동의를 허용해도 실제 기기 시험을 막는다', async () => {
  const ui = browser(`${origin}/push-lab/`, { standalone:true, session:true, configured:true });
  await import('./app.mjs?onboarding=mock');
  await settle();
  assert.match(ui.element('provider-message').textContent, /모의 발송/);
  assert.equal(ui.element('consent').disabled, false);
  ui.element('consent').checked = true;
  ui.element('consent').listeners.change();
  assert.equal(ui.element('subscribe').disabled, false);
  assert.equal(ui.element('self-test').disabled, true);
});

test('형식이 잘못된 초대 URL은 query와 fragment를 지우고 교환하지 않는다', async () => {
  const ui = browser(`${origin}/push-lab/?invite=secret#invite=invite-1`);
  await import('./app.mjs?onboarding=malformed');
  assert.equal(ui.url(), `${origin}/push-lab/`);
  assert.equal(ui.requests.filter(path => path.endsWith('/session/exchange')).length, 0);
  assert.match(ui.element('invite-message').textContent, /형식이 올바르지/);
});
