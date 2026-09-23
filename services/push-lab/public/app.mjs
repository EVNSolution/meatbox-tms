import { STAGES, browserGuidance, inviteFromFragment, notificationUiState, shouldRefreshProvider, subscriptionHasConsent, toTimestamp, viewForDelivery } from './model.mjs?v=20260922-3';
import { createFidRegistrationWorker, createLatestSerialQueue } from './fid-sync.mjs?v=20260922-5';
import { ApiResponseError, StaleSessionError, clearSessionData, createSessionGate, isTerminalSessionError } from './session-state.mjs?v=20260922-4';

const $ = id => document.getElementById(id);
const state = {
  csrfToken: '', deliveryIds: [], deliveryId: '', delivery: null, subscription: null, config: null,
  countdown: null, pollingTimer: null, providerReady: false, firebaseContext: null, notificationPhase: '',
  fidVersion: null, latestFidSync: null, fidSyncError: null, visibilityBound: false,
};
const sessionGate = createSessionGate();
const BOOTSTRAP_KEY = 'mb-push-registration-bootstrap-key';
let volatileBootstrapKey = '';

function registrationBootstrapKey() {
  try {
    const existing = sessionStorage.getItem(BOOTSTRAP_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(BOOTSTRAP_KEY, created);
    return created;
  } catch {
    return volatileBootstrapKey ||= crypto.randomUUID();
  }
}

function clearRegistrationBootstrapKey(value) {
  try { if (sessionStorage.getItem(BOOTSTRAP_KEY) === value) sessionStorage.removeItem(BOOTSTRAP_KEY); } catch {}
  if (volatileBootstrapKey === value) volatileBootstrapKey = '';
}

function rotateRegistrationBootstrapKey(value) {
  clearRegistrationBootstrapKey(value);
  return registrationBootstrapKey();
}

async function api(path, options = {}, generation = sessionGate.generation) {
  const publicPath = path === '/config' || path === '/session' || path === '/session/exchange';
  if (!publicPath) sessionGate.assert(generation);
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (state.csrfToken && options.method && !['GET', 'HEAD'].includes(options.method)) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(`/push-lab/api${path}`, { credentials: 'same-origin', ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiResponseError(response.status, body.error);
    if (isTerminalSessionError(error) && sessionGate.active) closeSession('배송조회 세션이 만료되었습니다. 새 TEST 초대 링크로 다시 인증해 주세요.');
    throw error;
  }
  if (path !== '/config') sessionGate.assert(generation);
  return body;
}

function closeSession(message) {
  sessionGate.close();
  clearInterval(state.pollingTimer);
  clearInterval(state.countdown);
  fidSync.cancelPending(new StaleSessionError());
  clearSessionData(state);
  $('delivery-view').hidden = true;
  $('invite-view').hidden = false;
  $('invite-form').hidden = true;
  $('invite-message').style.color = '#b42318';
  $('invite-message').textContent = message;
  $('stage-list').replaceChildren();
  $('eta-card').hidden = true;
  $('map-card').hidden = true;
}

function setDetail(message, error = false) {
  $('notification-detail').textContent = message;
  $('notification-detail').style.color = error ? '#b42318' : '';
}

function formatDate(value, withDate = false) {
  const date = new Date(toTimestamp(value));
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', withDate ? { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' } : { hour:'2-digit', minute:'2-digit' }).format(date);
}

function renderDelivery() {
  const delivery = state.delivery;
  if (!delivery) return;
  const view = viewForDelivery(delivery);
  $('delivery-title').textContent = view.unknown ? '배송 단계 확인 오류' : STAGES[view.index];
  $('order-id').textContent = `TEST 배송 ${delivery.id}`;
  $('stage-pill').textContent = view.unknown ? '단계 오류' : STAGES[view.index];
  $('stage-list').innerHTML = STAGES.map((label, index) => `<li class="${index < view.index ? 'done' : index === view.index ? 'current' : ''}"><span class="stage-dot">${index < view.index ? '✓' : index + 1}</span><span>${label}</span><span class="stage-test">TEST</span></li>`).join('');
  $('map-card').hidden = !view.showMap;
  $('truck').hidden = !view.showTruck;
  $('eta-card').hidden = !view.showEta;
  if (view.showEta) $('eta-text').textContent = `${formatDate(delivery.etaAt)} 도착예정`;
  $('status-note').textContent = view.unknown
    ? `알 수 없는 TEST 배송 단계(${String(delivery.stage ?? '없음')})입니다. 배송 상태를 임의로 표시하지 않습니다.`
    : view.etaError
    ? 'TEST ETA 오류: 도착예정이 기준시각보다 이전이어서 표시하지 않았습니다.'
    : view.index < 3 ? '초기 단계에는 지도·차량·ETA를 표시하지 않습니다.'
      : view.index === 3 ? 'TEST 지도만 표시합니다. 차량 위치와 ETA는 아직 제공하지 않습니다.'
        : view.index === 5 ? '근처 도착 단계도 확정 시각이 아닌 도착예정입니다.'
          : '표시된 지도·차량·ETA는 모두 TEST 합성 데이터입니다.';
  if (delivery.deliverable === false) $('status-note').textContent = '이 TEST 배송은 배포 확인용이며 알림 발송 대상이 아닙니다.';
  renderSubscription();
}

function renderSubscription() {
  const consentActive = subscriptionHasConsent(state.subscription);
  const capability = pushCapability();
  const ui = notificationUiState({ subscription:state.subscription, capability, providerReady:state.providerReady, phase:state.notificationPhase });
  $('notification-state').textContent = ui.label;
  $('notification-state').dataset.state = ui.key;
  $('notification-state').style.background = ui.active ? '#e6f7f1' : '';
  $('notification-state').style.color = ui.active ? '#087f5b' : '';
  $('subscribe').disabled = ui.active || ui.key === 'registering' || state.delivery?.deliverable === false || !$('consent').checked
    || !capability.supported || capability.permission === 'denied';
  $('self-test').disabled = !ui.active;
  $('unsubscribe').disabled = !consentActive;
  if (ui.active) setDetail(`서버 구독 저장 완료 · ${formatDate(state.subscription.expiresAt, true)}까지`);
  else if (consentActive && capability.permission === 'denied') setDetail('서버 동의는 남아 있지만 브라우저 권한이 차단되어 알림 수신 상태로 표시하지 않습니다.', true);
}

function pushCapability() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const webview = /; wv\)|\bwv\b|WebView|FBAN|FBAV|Instagram|KAKAOTALK/i.test(ua);
  const supported = isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && !(ios && !standalone) && !webview;
  return { ios, standalone, webview, supported, permission: 'Notification' in window ? Notification.permission : 'unsupported' };
}

function renderCapability() {
  const capability = pushCapability();
  $('support-message').textContent = browserGuidance(capability);
  $('consent').disabled = !capability.supported || capability.permission === 'denied';
  renderSubscription();
}

async function exchange(inviteCode) {
  const generation = sessionGate.begin();
  $('invite-message').textContent = 'TEST 초대를 확인하고 있습니다.';
  const exchangeKey = sessionStorage.getItem('mb-push-exchange-key') || crypto.randomUUID();
  sessionStorage.setItem('mb-push-exchange-key', exchangeKey);
  const result = await api('/session/exchange', { method:'POST', body:JSON.stringify({ inviteCode, exchangeKey }) }, generation);
  await openSession(result, generation);
}

async function openSession(result, generation) {
  sessionGate.assert(generation);
  state.csrfToken = result.csrfToken;
  state.deliveryIds = result.deliveryIds || [];
  const requested = new URL(location.href).searchParams.get('delivery');
  state.deliveryId = state.deliveryIds.includes(requested) ? requested : state.deliveryIds[0];
  if (!state.deliveryId) throw new Error('이 초대에 허용된 TEST 배송이 없습니다.');
  $('session-expiry').textContent = `세션 만료 ${formatDate(result.sessionExpiresAt, true)}`;
  history.replaceState(null, '', `${location.pathname}?delivery=${encodeURIComponent(state.deliveryId)}`);
  $('invite-view').hidden = true;
  $('delivery-view').hidden = false;
  await Promise.all([loadConfig(), pollDelivery(generation)]);
  sessionGate.assert(generation);
  await refreshActiveRegistration();
  sessionGate.assert(generation);
  startPolling();
}

async function restoreSession() {
  const generation = sessionGate.begin();
  await openSession(await api('/session', {}, generation), generation);
}

async function loadConfig() {
  state.config = await api('/config');
}

async function pollDelivery(generation = sessionGate.generation) {
  if (!state.deliveryId) return;
  try {
    const result = await api(`/deliveries/${encodeURIComponent(state.deliveryId)}`, {}, generation);
    sessionGate.assert(generation);
    state.delivery = result.delivery;
    state.subscription = result.subscription;
    state.fidVersion = result.registration?.fidVersion ?? result.subscription?.fidVersion ?? state.fidVersion;
    if (subscriptionHasConsent(state.subscription)) $('consent').checked = true;
    renderDelivery();
  } catch (error) {
    if (error instanceof StaleSessionError || isTerminalSessionError(error)) return false;
    $('status-note').textContent = error.message;
    return false;
  }
  return true;
}

function startPolling() {
  clearInterval(state.pollingTimer);
  const poll = () => { if (!document.hidden && sessionGate.active) pollDelivery(); };
  state.pollingTimer = setInterval(poll, 5000);
  if (!state.visibilityBound) {
    state.visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && sessionGate.active) pollDelivery().then(updated => updated && refreshActiveRegistration());
    });
  }
}

const fidRegistrationWorker = createFidRegistrationWorker({
    put:(body, input) => api('/registration', {
      method:'PUT',
      body:JSON.stringify({ ...body, provider:'fcm', projectId:input.projectId }),
    }, input.generation),
    refreshVersion:async input => {
      if (!await pollDelivery(input.generation)) throw new ApiResponseError(409, 'fid_version_refresh_failed');
      sessionGate.assert(input.generation);
    },
    getVersion:() => state.fidVersion,
    setVersion:(version, input) => { sessionGate.assert(input.generation); state.fidVersion = version; },
    assertCurrent:input => sessionGate.assert(input.generation),
    buildBody:(input, expectedFidVersion) => ({
      fid:input.fid,
      expectedFidVersion,
      ...(input.bootstrapKey ? { bootstrapKey:input.bootstrapKey } : {}),
    }),
    rotateBootstrap:input => {
      input.bootstrapKey = rotateRegistrationBootstrapKey(input.bootstrapKey);
      return input;
    },
  });

const fidSync = createLatestSerialQueue(async input => {
  try {
    const result = await fidRegistrationWorker(input);
    if (input.bootstrapKey) clearRegistrationBootstrapKey(input.bootstrapKey);
    state.fidSyncError = null;
    return result;
  } catch (error) {
    state.fidSyncError = error;
    throw error;
  }
});

async function firebaseContext() {
  if (state.firebaseContext) return state.firebaseContext;
  const firebase = state.config?.firebase;
  if (!firebase?.apiKey || !firebase?.projectId || !firebase?.appId || !firebase?.messagingSenderId || !firebase?.vapidKey) {
    throw new Error('Firebase 공개 설정 또는 VAPID 공개키가 준비되지 않았습니다.');
  }
  const messagingSdk = await import('/push-lab/vendor/firebase-vendor.mjs');
  const { initializeApp, getApp, getApps } = messagingSdk;
  if (!(await messagingSdk.isSupported())) throw new Error('Firebase Messaging이 이 브라우저를 지원하지 않습니다.');
  const sw = await navigator.serviceWorker.register('/push-lab/sw.js', { scope:'/push-lab/', updateViaCache:'none' });
  const messaging = messagingSdk.getMessaging(getApps().length ? getApp() : initializeApp(firebase));
  state.firebaseContext = { firebase, messagingSdk, messaging, sw };
  messagingSdk.onRegistered(messaging, async fid => {
    if (!sessionGate.active) return;
    const generation = sessionGate.generation;
    const input = {
      fid,
      generation,
      projectId:firebase.projectId,
      bootstrapKey:state.fidVersion == null ? registrationBootstrapKey() : '',
    };
    void fidSync.enqueue(input).catch(() => {});
    const settled = fidSync.whenIdle().then(() => {
      if (state.fidSyncError) throw state.fidSyncError;
    });
    state.latestFidSync = settled;
    try {
      await settled;
      sessionGate.assert(generation);
      state.providerReady = Boolean(await sw.pushManager.getSubscription());
      await pollDelivery(generation);
      state.notificationPhase = '';
    } catch (error) {
      if (error instanceof StaleSessionError || isTerminalSessionError(error)) return;
      state.providerReady = false;
      state.notificationPhase = 'failed';
      setDetail(`브라우저 등록 동기화 실패: ${error.message}`, true);
    }
    renderSubscription();
  });
  return state.firebaseContext;
}

async function refreshProviderRegistration() {
  if (pushCapability().permission !== 'granted') throw new Error('브라우저 알림 권한이 허용되지 않았습니다.');
  const { firebase, messagingSdk, messaging, sw } = await firebaseContext();
  const previousSync = state.latestFidSync;
  try {
    await messagingSdk.register(messaging, { vapidKey:firebase.vapidKey, serviceWorkerRegistration:sw });
    if (!state.latestFidSync || state.latestFidSync === previousSync) throw new Error('브라우저 FID 등록 응답이 없습니다.');
    await Promise.race([
      state.latestFidSync,
      new Promise((_, reject) => setTimeout(() => reject(new Error('브라우저 등록 시간이 초과되었습니다.')), 15000)),
    ]);
    return state.providerReady;
  } catch (error) {
    throw error;
  }
}

async function refreshActiveRegistration() {
  const capability = pushCapability();
  state.providerReady = false;
  state.notificationPhase = '';
  renderCapability();
  if (!shouldRefreshProvider(state.subscription, capability)) return;
  state.notificationPhase = 'registering';
  renderSubscription();
  try {
    await refreshProviderRegistration();
  } catch (error) {
    if (error instanceof StaleSessionError || isTerminalSessionError(error)) return;
    state.notificationPhase = 'failed';
    renderSubscription();
    setDetail(`브라우저 등록 재확인 실패: ${error.message}`, true);
  }
}

async function subscribe() {
  if (!$('consent').checked) return;
  try {
    state.notificationPhase = 'registering';
    renderSubscription();
    $('subscribe').disabled = true;
    const firebase = state.config?.firebase;
    if (!firebase?.apiKey || !firebase?.projectId || !firebase?.appId || !firebase?.messagingSenderId || !firebase?.vapidKey) {
      throw new Error('Firebase 공개 설정 또는 VAPID 공개키가 준비되지 않았습니다.');
    }
    setDetail('브라우저 알림 권한을 확인하고 있습니다.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('브라우저 알림 권한이 허용되지 않았습니다.');
    setDetail('브라우저를 FCM에 등록하고 있습니다.');
    await refreshProviderRegistration();
    setDetail('이번 배송 구독을 서버에 저장하고 있습니다.');
    state.subscription = await api(`/deliveries/${encodeURIComponent(state.deliveryId)}/subscription`, { method:'PUT', body:JSON.stringify({ consentVersion:'pilot-v1' }) });
    await pollDelivery();
    if (!state.subscription?.active) throw new Error('서버가 활성 구독을 확인하지 못했습니다.');
    state.notificationPhase = '';
    renderSubscription();
  } catch (error) {
    if (error instanceof StaleSessionError || isTerminalSessionError(error)) return;
    state.notificationPhase = pushCapability().permission === 'denied' ? '' : 'failed';
    setDetail(error.message, true);
    renderCapability();
  }
}

async function unsubscribe() {
  try {
    $('unsubscribe').disabled = true;
    const result = await api(`/deliveries/${encodeURIComponent(state.deliveryId)}/subscription`, { method:'DELETE' });
    state.subscription = null;
    state.notificationPhase = 'unsubscribed';
    $('consent').checked = false;
    renderSubscription();
    setDetail(result.boundary === 'sending_or_unknown_may_arrive'
      ? '철회가 저장되었습니다. 이미 발송 중이거나 결과가 불명인 알림은 도착할 수 있습니다.'
      : '철회가 저장되었습니다.');
  } catch (error) {
    if (error instanceof StaleSessionError || isTerminalSessionError(error)) return;
    setDetail(error.message, true); renderSubscription();
  }
}

async function selfTest() {
  try {
    $('self-test').disabled = true;
    const delay = state.config?.selfTestDelaySeconds || 30;
    await api(`/deliveries/${encodeURIComponent(state.deliveryId)}/self-test`, { method:'POST', body:JSON.stringify({ idempotencyKey:crypto.randomUUID() }) });
    let remaining = delay;
    clearInterval(state.countdown);
    setDetail(`${remaining}초 뒤 TEST 알림을 발송 대기열에서 처리합니다.`);
    state.countdown = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(state.countdown); setDetail('TEST 알림 처리 시각입니다. 실제 기기 표시 여부를 확인해 주세요.'); $('self-test').disabled = false; }
      else setDetail(`${remaining}초 뒤 TEST 알림을 발송 대기열에서 처리합니다.`);
    }, 1000);
  } catch (error) {
    if (error instanceof StaleSessionError || isTerminalSessionError(error)) return;
    $('self-test').disabled = false; setDetail(error.message, true);
  }
}

$('consent').addEventListener('change', renderSubscription);
$('subscribe').addEventListener('click', subscribe);
$('unsubscribe').addEventListener('click', unsubscribe);
$('self-test').addEventListener('click', selfTest);
$('invite-form').addEventListener('submit', event => { event.preventDefault(); exchange(new FormData(event.currentTarget).get('inviteCode')).catch(showInviteError); });

function showInviteError(error) {
  if (error instanceof StaleSessionError) return;
  $('invite-message').textContent = error.message;
  $('invite-message').style.color = '#b42318';
  $('invite-form').hidden = false;
}

renderCapability();
const inviteCode = inviteFromFragment(location.hash);
if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
if (inviteCode) exchange(inviteCode).catch(showInviteError);
else restoreSession().catch(() => {
  $('invite-message').textContent = 'TEST 초대 링크를 열거나 초대 코드를 입력해 주세요.';
  $('invite-form').hidden = false;
});
