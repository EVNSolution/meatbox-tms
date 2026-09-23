import { canSend, deliveryValidity, errorText, inviteAccess, nextStage, statusText } from './model.mjs';

const API = '/push-lab/control/api';
const el = (id) => document.getElementById(id);
const dateText = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? new Intl.DateTimeFormat('ko-KR', { dateStyle:'short', timeStyle:'short' }).format(Number(value)) : '—';

export class ApiFailure extends Error {
  constructor(status, code) { super(errorText(code, status)); this.status = status; this.code = code; }
}

export function createControlApi(fetchImpl = fetch) {
  let csrf = '';
  return {
    setCsrf(value) { csrf = value || ''; },
    async request(path, { method = 'GET', body, csrfToken } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken ?? csrf;
      const response = await fetchImpl(`${API}${path}`, {
        method, credentials:'same-origin', headers,
        ...(body !== undefined ? { body:JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiFailure(response.status, data.error);
      return data;
    },
  };
}

export function createRetryableAction() {
  let pending = null;
  return {
    async run(key, payload, send) {
      if (!pending || pending.key !== key) pending = { key, body:{ ...payload, eventId:crypto.randomUUID() } };
      try {
        const result = await send(pending.body);
        pending = null;
        return result;
      } catch (error) {
        if (error instanceof ApiFailure) pending = null;
        throw error;
      }
    },
    clear() { pending = null; },
  };
}

export function createTransientInviteLink(copyText) {
  let url = '';
  return {
    issue(invite) { url = invite.url; return inviteAccess(url); },
    clear() { url = ''; },
    get() { return url; },
    async copy() { if (!url) return false; await copyText(url); return true; },
  };
}

if (typeof document !== 'undefined') {
  const api = createControlApi();
  const stageAction = createRetryableAction();
  const sendAction = createRetryableAction();
  let deliveries = [];
  let cursor = null;
  let current = null;
  let selectedSubscriptionId = '';
  let senderMode = 'unknown';
  let inviteTimer;
  let busy = false;
  const inviteLink = createTransientInviteLink((url) => navigator.clipboard.writeText(url));

  function message(id, value, isError = false) {
    const node = el(id);
    node.textContent = value;
    node.classList.toggle('error', isError);
  }

  function clearInvite() {
    clearTimeout(inviteTimer);
    inviteLink.clear();
    el('invite-url').value = '';
    el('invite-expiry').textContent = '';
    el('invite-access').textContent = '';
    el('share-invite').hidden = true;
    el('invite-box').hidden = true;
  }

  function showInvite(invite) {
    clearInvite();
    const access = inviteLink.issue(invite);
    el('invite-url').value = inviteLink.get();
    el('invite-expiry').textContent = dateText(invite.expiresAt);
    el('invite-access').textContent = access === 'public-https'
      ? '모바일에서 열 수 있는 HTTPS 형식입니다. 실제 외부 접속과 배포 상태는 별도 확인이 필요합니다.'
      : access === 'local' ? '이 기기 또는 내부망 전용 테스트 주소입니다. 모바일에서 열 수 있다고 보장하지 않습니다.'
        : '모바일 접속을 확인하지 못한 주소입니다. 공개 HTTPS 배포를 확인해 주세요.';
    el('share-invite').hidden = access !== 'public-https' || typeof navigator.share !== 'function';
    el('invite-box').hidden = false;
    inviteTimer = setTimeout(clearInvite, 120_000);
  }

  function unauthenticated(text = '관리자 로그인이 필요합니다.') {
    api.setCsrf('');
    clearInvite();
    current = null;
    deliveries = [];
    cursor = null;
    stageAction.clear();
    sendAction.clear();
    el('console-view').hidden = true;
    el('detail').hidden = true;
    el('login-view').hidden = false;
    el('logout').hidden = true;
    el('mode').textContent = '로그인 필요';
    el('password').value = '';
    message('login-message', text);
  }

  async function run(action, destination = 'notice') {
    try { return await action(); } catch (error) {
      if (error.status === 401 && destination !== 'login-message') { unauthenticated(error.message); return null; }
      message(destination, error instanceof ApiFailure ? error.message : '연결에 실패했습니다. 다시 시도해 주세요.', true);
      return null;
    }
  }

  function authenticated(session) {
    api.setCsrf(session.csrfToken);
    senderMode = session.senderMode === 'mock' || session.senderMode === 'real' ? session.senderMode : 'unknown';
    el('mode').textContent = senderMode === 'mock' ? 'MOCK 발송 · 기기 표시 없음' : senderMode === 'real' ? 'FCM 서버 전송' : '발송 모드 미확인';
    el('session-expiry').textContent = `관리자 세션 ${dateText(session.expiresAt)} 만료`;
    el('login-view').hidden = true;
    el('console-view').hidden = false;
    el('logout').hidden = false;
    el('password').value = '';
  }

  async function loadSession() {
    const session = await run(() => api.request('/session'), 'login-message');
    if (!session) { unauthenticated(el('login-message').textContent); return; }
    authenticated(session);
    await loadDeliveries();
  }

  function cell(row, content, className = '') {
    const td = row.insertCell();
    td.className = className;
    td.textContent = content;
    return td;
  }

  function badge(container, value, kind = '') {
    const span = document.createElement('span');
    span.className = `status ${kind}`;
    span.textContent = value;
    container.append(span);
  }

  function renderDeliveries() {
    const body = el('delivery-rows');
    body.replaceChildren();
    const query = el('filter').value.trim().toLocaleLowerCase();
    const visible = deliveries.filter((delivery) => `${delivery.id} ${delivery.userId}`.toLocaleLowerCase().includes(query));
    for (const delivery of visible) {
      const row = body.insertRow();
      row.classList.toggle('selected', current?.delivery?.id === delivery.id);
      const first = cell(row, '');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'row-button';
      button.textContent = delivery.userId;
      button.setAttribute('aria-label', `${delivery.userId} TEST 배송 상세 열기`);
      button.addEventListener('click', () => openDetail(delivery.id));
      first.append(button);
      const id = document.createElement('small');
      id.textContent = delivery.id;
      first.append(id);
      cell(row, delivery.stage);
      badge(cell(row, ''), deliveryValidity(delivery), deliveryValidity(delivery) === '유효' ? 'ok' : 'bad');
      cell(row, String(delivery.activeSubscriptions ?? 0));
      badge(cell(row, ''), statusText(delivery.latestStatus, senderMode), delivery.latestStatus === 'accepted' ? 'ok' : delivery.latestStatus === 'failed' ? 'bad' : 'warn');
      cell(row, `${dateText(delivery.etaAt)} / ${dateText(delivery.expiresAt)}`);
    }
    el('count').textContent = `${visible.length}건 표시${cursor ? ' · 더 보기 가능' : ''}`;
    el('table-state').textContent = visible.length ? '' : query ? '일치하는 TEST 배송이 없습니다.' : 'TEST 배송이 없습니다. 위에서 새 배송을 생성할 수 있습니다.';
    el('load-more').hidden = !cursor;
  }

  async function loadDeliveries(more = false) {
    message('notice', 'TEST 배송을 불러오는 중입니다.');
    const path = `/deliveries?limit=50${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await run(() => api.request(path));
    if (!data) return;
    deliveries = more ? [...deliveries, ...data.deliveries] : data.deliveries;
    cursor = data.nextCursor;
    renderDeliveries();
    message('notice', '');
  }

  function renderDetail(data) {
    current = data;
    const delivery = data.delivery;
    el('detail-title').textContent = `${delivery.userId} · ${delivery.id}`;
    el('detail-stage').textContent = delivery.stage;
    el('detail-time').textContent = `${dateText(delivery.baselineAt)} / ${dateText(delivery.etaAt)}`;
    el('detail-expiry').textContent = dateText(delivery.expiresAt);
    el('detail-revision').textContent = String(delivery.revision);
    const next = nextStage(delivery.stage);
    el('advance-stage').textContent = next ? `다음 단계: ${next}` : '마지막 단계';
    el('advance-stage').disabled = !next || deliveryValidity(delivery) !== '유효' || busy;
    el('renew-invite').disabled = deliveryValidity(delivery) !== '유효' || busy;
    const subscriptions = data.subscriptions || [];
    const subBody = el('subscription-rows');
    subBody.replaceChildren();
    for (const subscription of subscriptions) {
      const row = subBody.insertRow();
      const choice = cell(row, '');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'selected-subscription';
      radio.value = subscription.id;
      radio.setAttribute('aria-label', `${subscription.id} 구독 선택`);
      radio.checked = selectedSubscriptionId === subscription.id;
      radio.disabled = !canSend(delivery, subscription) || busy;
      radio.addEventListener('change', () => { selectedSubscriptionId = subscription.id; updateSendButton(); });
      choice.append(radio);
      cell(row, subscription.id);
      badge(cell(row, ''), subscription.status, subscription.status === 'active' ? 'ok' : 'bad');
      cell(row, subscription.providerActive ? '활성' : '비활성');
      cell(row, `${dateText(subscription.subscribedAt)} / ${dateText(subscription.expiresAt)}`);
    }
    el('subscription-empty').hidden = subscriptions.length > 0;
    if (!subscriptions.some((item) => item.id === selectedSubscriptionId && canSend(delivery, item))) selectedSubscriptionId = '';
    updateSendButton();
    const outboxBody = el('outbox-rows');
    outboxBody.replaceChildren();
    for (const item of data.outbox || []) {
      const row = outboxBody.insertRow();
      badge(cell(row, ''), statusText(item.status, senderMode), item.status === 'accepted' ? 'ok' : item.status === 'failed' ? 'bad' : 'warn');
      cell(row, item.notificationType);
      cell(row, String(item.attempts ?? 0));
      cell(row, dateText(item.updatedAt));
      cell(row, item.errorClass || '—');
    }
    el('outbox-empty').hidden = Boolean(data.outbox?.length);
    el('detail-content').hidden = false;
    renderDeliveries();
  }

  function updateSendButton() {
    const selected = current?.subscriptions?.find((item) => item.id === selectedSubscriptionId);
    const allowed = canSend(current?.delivery, selected) && !busy;
    el('send-test').disabled = !allowed;
    el('send-hint').textContent = selectedSubscriptionId && allowed ? `선택: ${selectedSubscriptionId}` : '활성 구독 한 건을 선택해야 TEST 알림을 보낼 수 있습니다.';
  }

  async function openDetail(id) {
    if (current?.delivery?.id !== id) { clearInvite(); selectedSubscriptionId = ''; stageAction.clear(); sendAction.clear(); }
    el('detail').hidden = false;
    el('detail-content').hidden = true;
    message('detail-state', '배송 상세를 불러오는 중입니다.');
    const data = await run(() => api.request(`/deliveries/${encodeURIComponent(id)}`), 'detail-state');
    if (!data) return;
    renderDetail(data);
    message('detail-state', '');
  }

  function setBusy(value) {
    busy = value;
    el('advance-stage').disabled = value || !current || !nextStage(current.delivery.stage) || deliveryValidity(current.delivery) !== '유효';
    el('renew-invite').disabled = value || !current || deliveryValidity(current.delivery) !== '유효';
    updateSendButton();
  }

  async function mutate(action, successMessage) {
    setBusy(true);
    message('detail-state', '처리 중입니다.');
    const result = await run(action, 'detail-state');
    setBusy(false);
    if (!result) return null;
    message('detail-state', successMessage);
    return result;
  }

  el('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = el('password').value;
    message('login-message', '로그인 중입니다.');
    const challenge = await run(() => api.request('/login-challenge'), 'login-message');
    if (!challenge) { el('password').value = ''; return; }
    const session = await run(() => api.request('/login', { method:'POST', body:{ password }, csrfToken:challenge.csrfToken }), 'login-message');
    el('password').value = '';
    if (!session) return;
    authenticated(session);
    await loadDeliveries();
  });
  el('logout').addEventListener('click', async () => {
    const result = await run(() => api.request('/logout', { method:'POST', body:{} }));
    if (result) unauthenticated('로그아웃했습니다.');
  });
  el('filter').addEventListener('input', renderDeliveries);
  el('refresh').addEventListener('click', () => loadDeliveries());
  el('load-more').addEventListener('click', () => loadDeliveries(true));
  el('show-create').addEventListener('click', () => {
    el('create-wrap').hidden = !el('create-wrap').hidden;
    el('show-create').setAttribute('aria-expanded', String(!el('create-wrap').hidden));
    if (!el('create-wrap').hidden) {
      const now = Date.now();
      const local = (value) => {
        const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
        return date.toISOString().slice(0, 16);
      };
      if (!el('baseline-at').value) el('baseline-at').value = local(now);
      if (!el('expires-at').value) el('expires-at').value = local(now + 3_600_000);
      el('user-id').focus();
    }
  });
  el('create-wrap').addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = el('user-id').value.trim();
    const baselineAt = el('baseline-at').value ? new Date(el('baseline-at').value).getTime() : Date.now();
    const etaAt = el('eta-at').value ? new Date(el('eta-at').value).getTime() : null;
    const expiresAt = new Date(el('expires-at').value).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000 || (etaAt && etaAt < baselineAt)) {
      message('notice', '만료는 현재 이후 24시간 이내, ETA는 기준 시각 이후로 입력해 주세요.', true); return;
    }
    message('notice', 'TEST 배송 생성 중입니다.');
    const result = await run(() => api.request('/deliveries', { method:'POST', body:{ userId, baselineAt, etaAt, expiresAt } }));
    if (!result) return;
    el('create-wrap').reset();
    el('create-wrap').hidden = true;
    el('show-create').setAttribute('aria-expanded', 'false');
    await loadDeliveries();
    await openDetail(result.delivery.id);
    showInvite(result.invite);
    message('detail-state', 'TEST 배송을 생성했습니다. 보안 링크는 지금 복사해 주세요.');
  });
  el('close-detail').addEventListener('click', () => {
    clearInvite(); current = null; selectedSubscriptionId = ''; el('detail').hidden = true; renderDeliveries();
  });
  el('renew-invite').addEventListener('click', async () => {
    if (!current) return;
    clearInvite();
    const id = current.delivery.id;
    const result = await mutate(() => api.request(`/deliveries/${encodeURIComponent(id)}/invitations`, { method:'POST', body:{} }), '새 고객 링크를 발급했습니다. 이전 미사용 링크는 만료되었습니다.');
    if (result) showInvite(result.invite);
  });
  el('copy-invite').addEventListener('click', async () => {
    if (!inviteLink.get()) return;
    try {
      await inviteLink.copy();
      message('detail-state', '보안 링크를 복사했습니다. 공유 대상과 만료 시각을 확인해 주세요.');
    } catch { message('detail-state', '자동 복사에 실패했습니다. 링크 입력칸에서 직접 복사해 주세요.', true); el('invite-url').select(); }
  });
  el('share-invite').addEventListener('click', async () => {
    const url = inviteLink.get();
    if (inviteAccess(url) !== 'public-https' || typeof navigator.share !== 'function') return;
    try { await navigator.share({ title:'TEST 미트박스 배송조회', url }); }
    catch (error) { if (error?.name !== 'AbortError') message('detail-state', '공유하지 못했습니다. 링크 복사를 이용해 주세요.', true); }
  });
  el('clear-invite').addEventListener('click', clearInvite);
  el('advance-stage').addEventListener('click', async () => {
    if (!current || !nextStage(current.delivery.stage)) return;
    const { id, revision, stage } = current.delivery;
    const next = nextStage(stage);
    const result = await mutate(() => stageAction.run(`${id}:${revision}:${next}`, { stage:next, expectedRevision:revision },
      (body) => api.request(`/deliveries/${encodeURIComponent(id)}/stage`, { method:'POST', body })),
    '단계를 변경했습니다. 알림은 자동 발송되지 않았습니다.');
    if (result) { await loadDeliveries(); await openDetail(id); }
  });
  el('send-test').addEventListener('click', async () => {
    if (!current) return;
    const { id, revision } = current.delivery;
    const subscription = current.subscriptions.find((item) => item.id === selectedSubscriptionId);
    if (!canSend(current.delivery, subscription)) return;
    const subscriptionId = selectedSubscriptionId;
    const result = await mutate(() => sendAction.run(`${id}:${revision}:${subscriptionId}`, { subscriptionId, expectedRevision:revision },
      (body) => api.request(`/deliveries/${encodeURIComponent(id)}/test-notifications`, { method:'POST', body })),
    'TEST 알림 한 건을 대기열에 넣었습니다. 기기 수신·표시는 아직 확인되지 않았습니다.');
    if (result) { await loadDeliveries(); await openDetail(id); }
  });
  el('refresh-detail').addEventListener('click', () => current && openDetail(current.delivery.id));
  loadSession();
}
