import { authActions, authState, canSend, chooseSubscriptionId, deliveryValidity, errorText, inviteAccess, nextStage, statusText } from './model.mjs';

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
  let authMode = 'unknown';
  let checkingSession = false;
  let waitingForTmsLogin = false;
  let inviteTimer;
  let busy = false;
  let viewGeneration = 0;
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
    el('invite-box').hidden = true;
  }

  function showInvite(invite, deliveryId, generation) {
    if (generation !== viewGeneration || current?.delivery?.id !== deliveryId || el('console-view').hidden || el('detail').hidden) return;
    clearInvite();
    const access = inviteLink.issue(invite);
    el('invite-url').value = inviteLink.get();
    el('invite-expiry').textContent = dateText(invite.expiresAt);
    el('invite-access').textContent = access === 'public-https'
      ? '이 링크를 받을 사람에게만 전달해 주세요.'
      : access === 'local' ? '내부망 주소입니다. 다른 기기에서 열리지 않을 수 있습니다.'
        : '모바일 접속을 확인하지 못한 주소입니다.';
    el('invite-box').hidden = false;
    inviteTimer = setTimeout(clearInvite, 120_000);
    el('invite-box').scrollIntoView({ block:'center' });
    el('copy-invite').focus({ preventScroll:true });
  }

  function showAuthState(state, text) {
    viewGeneration += 1;
    api.setCsrf('');
    clearInvite();
    current = null;
    deliveries = [];
    cursor = null;
    selectedSubscriptionId = '';
    stageAction.clear();
    sendAction.clear();
    el('console-view').hidden = true;
    el('detail').hidden = true;
    el('login-view').hidden = false;
    el('logout').hidden = true;
    el('exit-console').hidden = true;
    el('mode').textContent = state === 'login' ? '로그인 필요' : state === 'forbidden' ? '권한 없음' : '세션 확인 불가';
    el('login-title').textContent = state === 'login' ? '관리자 로그인' : state === 'forbidden' ? '관제 접근 권한 없음' : '세션 확인 불가';
    el('login-description').textContent = state === 'forbidden'
      ? '현재 TMS 계정은 TEST 관제 허용 목록에 없습니다. 관리자에게 계정 권한을 확인해 주세요.'
      : state === 'unavailable' ? '인증 연결 상태를 확인하지 못했습니다. 배송 데이터는 표시하지 않습니다.'
      : authMode === 'tms' ? '기존 미트박스 TMS 계정으로 로그인한 뒤 이 탭에서 세션을 다시 확인해 주세요.'
          : '배송조회 링크와 알림을 관리합니다.';
    const actions = authActions(state, authMode);
    el('login-form').hidden = !actions.password;
    el('tms-login').hidden = !actions.tmsLogin;
    el('retry-session').hidden = !actions.retry;
    el('password').value = '';
    message('login-message', text || (state === 'login' ? '로그인이 필요합니다.' : '잠시 후 다시 확인해 주세요.'), state !== 'login');
  }

  async function run(action, destination = 'notice') {
    try { return await action(); } catch (error) {
      if (destination !== 'login-message' && (error.status === 401 || error.code === 'admin_forbidden'
        || error.code === 'tms_auth_unavailable' || authMode === 'tms' && !(error instanceof ApiFailure))) {
        showAuthState(authState(error, authMode), error.message); return null;
      }
      message(destination, error instanceof ApiFailure ? error.message : '연결에 실패했습니다. 다시 시도해 주세요.', true);
      return null;
    }
  }

  function authenticated(session) {
    viewGeneration += 1;
    api.setCsrf(session.csrfToken);
    senderMode = session.senderMode === 'mock' || session.senderMode === 'real' ? session.senderMode : 'unknown';
    el('mode').textContent = senderMode === 'mock' ? '모의 발송 · 실제 알림 없음' : senderMode === 'real' ? '실제 발송' : '발송 모드 미확인';
    el('session-expiry').textContent = authMode === 'tms' ? 'TMS 계정으로 접속 중' : `관리자 세션 ${dateText(session.expiresAt)} 만료`;
    el('login-view').hidden = true;
    el('console-view').hidden = false;
    el('logout').hidden = authMode !== 'password';
    el('exit-console').hidden = authMode !== 'tms';
    el('password').value = '';
  }

  async function loadSession() {
    if (checkingSession) return;
    const generation = viewGeneration;
    checkingSession = true;
    el('retry-session').disabled = true;
    message('login-message', '세션을 확인하는 중입니다.');
    try {
      if (authMode === 'unknown') {
        const config = await api.request('/auth-mode');
        if (generation !== viewGeneration) return;
        if (config.authMode !== 'tms' && config.authMode !== 'password') throw new Error('unknown auth mode');
        authMode = config.authMode;
      }
      const session = await api.request('/session');
      if (generation !== viewGeneration) return;
      if (session.authMode && session.authMode !== authMode) throw new Error('auth mode changed');
      authenticated(session);
      await loadDeliveries();
    } catch (error) {
      if (generation !== viewGeneration) return;
      showAuthState(authState(error, authMode), error instanceof ApiFailure ? error.message : '인증 연결에 실패했습니다. 잠시 후 다시 확인해 주세요.');
    } finally {
      checkingSession = false;
      el('retry-session').disabled = false;
    }
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
      button.setAttribute('aria-label', `${delivery.userId} 배송 상세 열기`);
      button.addEventListener('click', () => openDetail(delivery.id));
      first.append(button);
      const stage = cell(row, delivery.stage);
      if (deliveryValidity(delivery) !== '유효') {
        const expired = document.createElement('small');
        expired.textContent = '만료';
        stage.append(expired);
      }
      cell(row, `${delivery.activeSubscriptions ?? 0}대`);
      badge(cell(row, ''), statusText(delivery.latestStatus, senderMode), delivery.latestStatus === 'accepted' ? 'ok' : delivery.latestStatus === 'failed' ? 'bad' : 'warn');
      cell(row, dateText(delivery.expiresAt));
    }
    el('count').textContent = `${visible.length}건 표시${cursor ? ' · 더 보기 가능' : ''}`;
    el('table-state').textContent = visible.length ? '' : query ? '일치하는 배송이 없습니다.' : '배송이 없습니다. 위에서 새 배송을 생성할 수 있습니다.';
    el('load-more').hidden = !cursor;
  }

  async function loadDeliveries(more = false) {
    const generation = viewGeneration;
    message('notice', '배송 목록을 불러오는 중입니다.');
    const path = `/deliveries?limit=50${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await run(() => api.request(path));
    if (!data || generation !== viewGeneration || el('console-view').hidden) return null;
    deliveries = more ? [...deliveries, ...data.deliveries] : data.deliveries;
    cursor = data.nextCursor;
    renderDeliveries();
    message('notice', '');
    return data;
  }

  function renderDetail(data) {
    current = data;
    const delivery = data.delivery;
    el('detail-title').textContent = delivery.userId;
    el('detail-stage').textContent = delivery.stage;
    el('detail-expiry').textContent = dateText(delivery.expiresAt);
    el('detail-id').textContent = delivery.id;
    el('detail-revision').textContent = String(delivery.revision);
    el('detail-baseline').textContent = dateText(delivery.baselineAt);
    el('detail-eta').textContent = dateText(delivery.etaAt);
    const next = nextStage(delivery.stage);
    el('advance-stage').textContent = next ? `다음 단계: ${next}` : '마지막 단계';
    el('advance-stage').disabled = !next || deliveryValidity(delivery) !== '유효' || busy;
    el('renew-invite').disabled = deliveryValidity(delivery) !== '유효' || busy;
    const subscriptions = data.subscriptions || [];
    selectedSubscriptionId = chooseSubscriptionId(delivery, subscriptions, selectedSubscriptionId);
    const subBody = el('subscription-rows');
    subBody.replaceChildren();
    for (const [index, subscription] of subscriptions.entries()) {
      const row = subBody.insertRow();
      const choice = cell(row, '');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'selected-subscription';
      radio.value = subscription.id;
      radio.setAttribute('aria-label', `기기 ${index + 1} 선택`);
      radio.checked = selectedSubscriptionId === subscription.id;
      radio.disabled = !canSend(delivery, subscription) || busy;
      radio.addEventListener('change', () => { selectedSubscriptionId = subscription.id; updateSendButton(); });
      choice.append(radio);
      const device = cell(row, `기기 ${index + 1}`);
      const technical = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '기술 ID';
      const code = document.createElement('code');
      code.textContent = subscription.id;
      technical.append(summary, code);
      device.append(technical);
      const available = canSend(delivery, subscription);
      badge(cell(row, ''), available ? '알림 가능' : '사용 불가', available ? 'ok' : 'bad');
      cell(row, dateText(subscription.expiresAt));
    }
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
    const allowed = canSend(current?.delivery, selected) && !busy && senderMode !== 'unknown';
    el('send-test').disabled = !allowed;
    el('send-test').textContent = senderMode === 'mock' ? '모의 알림 보내기' : '알림 보내기';
    const eligible = current?.subscriptions?.filter((item) => canSend(current.delivery, item)) || [];
    el('send-hint').textContent = senderMode === 'unknown' ? '발송 모드를 확인할 수 없습니다.'
      : eligible.length === 0 ? current?.subscriptions?.length ? '보낼 수 있는 기기가 없습니다.' : '등록된 기기가 없습니다.'
        : eligible.length === 1 ? '기기 1대를 선택했습니다.'
          : selectedSubscriptionId ? '선택한 기기 1대에만 보냅니다.' : '받을 기기 1대를 선택해 주세요.';
  }

  async function openDetail(id) {
    const generation = ++viewGeneration;
    if (current?.delivery?.id !== id) { clearInvite(); selectedSubscriptionId = ''; stageAction.clear(); sendAction.clear(); }
    el('detail').hidden = false;
    el('detail-content').hidden = true;
    message('detail-state', '배송 상세를 불러오는 중입니다.');
    const data = await run(() => api.request(`/deliveries/${encodeURIComponent(id)}`), 'detail-state');
    if (!data || generation !== viewGeneration || el('console-view').hidden) return null;
    renderDetail(data);
    message('detail-state', '');
    return data;
  }

  function setBusy(value) {
    busy = value;
    el('advance-stage').disabled = value || !current || !nextStage(current.delivery.stage) || deliveryValidity(current.delivery) !== '유효';
    el('renew-invite').disabled = value || !current || deliveryValidity(current.delivery) !== '유효';
    updateSendButton();
  }

  async function mutate(action, successMessage) {
    const generation = viewGeneration;
    setBusy(true);
    message('detail-state', '처리 중입니다.');
    const result = await run(action, 'detail-state');
    setBusy(false);
    if (!result || generation !== viewGeneration || el('console-view').hidden) return null;
    message('detail-state', successMessage);
    return result;
  }

  el('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (authMode !== 'password') return;
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
    if (authMode !== 'password') return;
    const result = await run(() => api.request('/logout', { method:'POST', body:{} }));
    if (result) showAuthState('login', '로그아웃했습니다.');
  });
  el('retry-session').addEventListener('click', loadSession);
  el('tms-login').addEventListener('click', () => { waitingForTmsLogin = true; });
  window.addEventListener('focus', () => {
    if (!waitingForTmsLogin || authMode !== 'tms') return;
    waitingForTmsLogin = false;
    loadSession();
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
    const generation = viewGeneration;
    const userId = el('user-id').value.trim();
    const baselineAt = el('baseline-at').value ? new Date(el('baseline-at').value).getTime() : Date.now();
    const etaAt = el('eta-at').value ? new Date(el('eta-at').value).getTime() : null;
    const expiresAt = new Date(el('expires-at').value).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000 || (etaAt && etaAt < baselineAt)) {
      message('notice', '만료는 현재 이후 24시간 이내, ETA는 기준 시각 이후로 입력해 주세요.', true); return;
    }
    message('notice', 'TEST 배송 생성 중입니다.');
    const result = await run(() => api.request('/deliveries', { method:'POST', body:{ userId, baselineAt, etaAt, expiresAt } }));
    if (!result || generation !== viewGeneration || el('console-view').hidden) return;
    el('create-wrap').reset();
    el('create-wrap').hidden = true;
    el('show-create').setAttribute('aria-expanded', 'false');
    if (!await loadDeliveries()) return;
    if (!await openDetail(result.delivery.id)) return;
    showInvite(result.invite, result.delivery.id, viewGeneration);
    message('detail-state', '배송을 생성했습니다. 배송조회 링크를 복사해 주세요.');
  });
  el('close-detail').addEventListener('click', () => {
    viewGeneration += 1;
    clearInvite(); current = null; selectedSubscriptionId = ''; el('detail').hidden = true; renderDeliveries();
  });
  el('renew-invite').addEventListener('click', async () => {
    if (!current) return;
    const generation = viewGeneration;
    clearInvite();
    const id = current.delivery.id;
    const result = await mutate(() => api.request(`/deliveries/${encodeURIComponent(id)}/invitations`, { method:'POST', body:{} }), '새 고객 링크를 발급했습니다. 이전 미사용 링크는 만료되었습니다.');
    if (result) showInvite(result.invite, id, generation);
  });
  el('copy-invite').addEventListener('click', async () => {
    if (!inviteLink.get()) return;
    try {
      await inviteLink.copy();
      message('detail-state', '배송조회 링크를 복사했습니다. 받을 사람과 만료 시각을 확인해 주세요.');
    } catch { message('detail-state', '복사에 실패했습니다. 링크 입력칸에서 직접 복사해 주세요.', true); el('invite-url').select(); }
  });
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
    senderMode === 'mock' ? '모의 알림을 대기열에 넣었습니다. 실제 기기 알림은 없습니다.' : '알림 한 건을 대기열에 넣었습니다. 기기 표시는 아직 확인되지 않았습니다.');
    if (result) { await loadDeliveries(); await openDetail(id); }
  });
  el('refresh-detail').addEventListener('click', () => current && openDetail(current.delivery.id));
  loadSession();
}
