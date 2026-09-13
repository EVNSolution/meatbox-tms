import { adaptSimulation, calculatedEtaText, customerHeadline, publishedEtaText } from './simulation-adapter.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';

const pages = {
  deliveries: { title: '배송 현황', eyebrow: '차량 1대의 배송 8곳', description: '배송 순서와 고객 공식 ETA, 계산 ETA를 함께 확인합니다.' },
  control: { title: '단말 관제', eyebrow: '차량 장착형 TMS', description: '차량의 배송 진행을 확인합니다. 실제 장착 단말 정보는 제공되지 않았습니다.' },
  customer: { title: '고객 보기', eyebrow: '선택 배송 미리보기', description: '운영 화면과 같은 고객 공식 ETA를 고객 안내 형태로 확인합니다.' },
};
const phaseLabels = { unordered: '주문 전', idle: '주문 접수', preparing: '출고 준비', delivering: '배송 중', done: '배송 완료' };
const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '건너뜀' };
const state = {
  page: pageFromHash(location.hash),
  data: null,
  selectedId: null,
  query: '',
  status: 'all',
  tab: 'timeline',
  connected: false,
};
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const badge = (text, color = 'neutral') => `<span class="badge ${color}">${escapeHtml(text)}</span>`;
const keyValue = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '미확인')}</dd></div>`;

let socket = null;
let reconnectTimer = null;
let bootId = null;

const scenarioTools = mountScenarioTools({
  onSend(type, extra = {}) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (extra.stopId && ['arrive_stop', 'complete_stop'].includes(type)) {
      state.selectedId = extra.stopId;
      state.query = '';
      state.status = 'all';
      byId('delivery-search').value = '';
      byId('delivery-status').value = 'all';
    }
    socket.send(JSON.stringify({ type, ...extra }));
  },
});
scenarioTools.update(null, false);

function pageFromHash(hash) {
  const page = hash.replace(/^#\//, '');
  return Object.hasOwn(pages, page) ? page : 'deliveries';
}

function redirectToLogin() {
  location.replace('/login?next=%2Fcombined%2F');
}

function setConnection(kind, title, detail) {
  const badgeEl = byId('connection-state');
  badgeEl.dataset.state = kind;
  badgeEl.textContent = { loading: '연결 중', connected: '실시간 연결', error: '연결 끊김' }[kind];
  byId('connection-panel').hidden = kind === 'connected';
  byId('live-pages').hidden = kind !== 'connected';
  byId('connection-title').textContent = title;
  byId('connection-detail').textContent = detail;
  byId('retry-connection').hidden = kind !== 'error';
}

async function start() {
  clearTimeout(reconnectTimer);
  setConnection('loading', '로그인 상태를 확인하고 있습니다.', '잠시만 기다려 주세요.');
  try {
    const response = await fetch('/api/session', { headers: { accept: 'application/json' } });
    if (response.status === 401) return redirectToLogin();
    if (!response.ok) throw new Error(`세션 확인 실패 (${response.status})`);
    connect();
  } catch (error) {
    setConnection('error', '서버에 연결할 수 없습니다.', error.message);
  }
}

function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  setConnection('loading', '실시간 시뮬레이션에 연결하고 있습니다.', '상태 스트림을 기다리는 중입니다.');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws/simulation`);
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      scenarioTools.showError('요청을 처리하지 못했습니다. 현재 단계를 확인하고 다시 시도해 주세요.');
      return;
    }
    if (message.boot) {
      if (bootId && bootId !== message.boot) return location.reload();
      bootId = message.boot;
    }
    if (message.type !== 'state') return;
    try {
      state.data = adaptSimulation(message.state);
      state.connected = true;
      setConnection('connected', '', '');
      render();
    } catch (error) {
      state.connected = false;
      setConnection('error', '받은 시뮬레이션 상태를 표시할 수 없습니다.', error.message);
    }
  });
  socket.addEventListener('close', async event => {
    state.connected = false;
    scenarioTools.update(state.data, false);
    if ([1008, 4401, 4403].includes(event.code) || /auth|login|session/i.test(event.reason)) return redirectToLogin();
    try {
      const session = await fetch('/api/session', { headers: { accept: 'application/json' } });
      if (session.status === 401) return redirectToLogin();
    } catch {}
    setConnection('error', '실시간 연결이 끊겼습니다.', '잠시 후 자동으로 다시 연결합니다.');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  });
  socket.addEventListener('error', () => {
    if (socket?.readyState !== WebSocket.CLOSED) socket.close();
  });
}

function visibleDeliveries() {
  if (!state.data) return [];
  const needle = state.query.trim().toLocaleLowerCase('ko-KR');
  return state.data.deliveries.filter(delivery => {
    const search = [delivery.id, delivery.name, delivery.address].some(value => value.toLocaleLowerCase('ko-KR').includes(needle));
    return search && (state.status === 'all' || delivery.status === state.status);
  });
}

function selectedDelivery(visible = visibleDeliveries()) {
  return visible.find(delivery => delivery.id === state.selectedId)
    ?? visible.find(delivery => delivery.id === state.data?.customerStopId)
    ?? visible[0]
    ?? null;
}

function etaDisplay(delivery) {
  if (!delivery.ordered) return '미확인';
  if (delivery.status === 'done') return delivery.completedAt || '미확인';
  if (delivery.status === 'skipped') return '미확인';
  return publishedEtaText(delivery);
}

function render() {
  if (!state.data) return;
  const visible = visibleDeliveries();
  const selected = selectedDelivery(visible);
  state.selectedId = selected?.id ?? null;
  renderPage();
  renderSummary();
  renderDeliveries(visible, selected);
  renderControl(visible, selected);
  renderCustomer(visible, selected);
  renderTabs();
  byId('snapshot-clock').textContent = state.data.simClock || '--:--';
  scenarioTools.update(state.data, state.connected);
}

function renderPage() {
  const page = pages[state.page];
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== state.page; });
  document.querySelectorAll('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('app-title').textContent = `합본 ${page.title}`;
  byId('page-heading').textContent = page.title;
  byId('page-eyebrow').textContent = page.eyebrow;
  byId('page-description').textContent = page.description;
  byId('toggle-map').hidden = state.page !== 'control';
  document.title = `${page.title} · 미트박스 TMS 합본`;
}

function renderSummary() {
  const deliveries = state.data.deliveries;
  byId('summary-counts').innerHTML = `
    <div><span>차량</span><strong>${state.data.vehicle ? 1 : 0}</strong></div>
    <div><span>배송</span><strong>${deliveries.length}</strong></div>
    <div><span>완료</span><strong>${deliveries.filter(item => item.status === 'done').length}</strong></div>`;
}

function renderDeliveries(visible, selected) {
  byId('delivery-count').textContent = `${visible.length}건`;
  byId('delivery-empty').hidden = visible.length > 0;
  byId('delivery-rows').innerHTML = visible.map(delivery => `
    <tr class="${delivery.id === state.selectedId ? 'selected' : ''}">
      <td><button type="button" class="delivery-select" data-select="${escapeHtml(delivery.id)}" aria-pressed="${delivery.id === state.selectedId}"><strong>${delivery.sequence}. ${escapeHtml(delivery.name)}</strong><span>${escapeHtml(delivery.address)}</span></button></td>
      <td>${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}</td>
      <td><strong>${escapeHtml(publishedEtaText(delivery))}</strong><small>${delivery.ordered && delivery.officialEta?.updatedAt ? `${escapeHtml(delivery.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</small></td>
      <td><strong>${escapeHtml(calculatedEtaText(delivery))}</strong><small>계산 ETA</small></td>
      <td><strong>${escapeHtml(delivery.arrivedAt || '미확인')}</strong><small>완료 ${escapeHtml(delivery.completedAt || '미확인')}</small></td>
    </tr>`).join('');
  byId('delivery-selection').innerHTML = selected ? `
    <div class="panel-heading"><h2>선택 배송</h2>${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}</div>
    <div class="selection-body"><p class="eyebrow">${selected.sequence}번째 배송</p><h3>${escapeHtml(selected.name)}</h3><p class="eyebrow">${selected.status === 'done' ? '배송 완료 시각' : '고객 공식 ETA'}</p><strong class="selection-eta">${escapeHtml(etaDisplay(selected))}</strong><p class="muted">${selected.status === 'done' ? `실제 도착 ${escapeHtml(selected.arrivedAt || '미확인')}` : selected.ordered && selected.officialEta?.updatedAt ? `${escapeHtml(selected.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</p><dl class="key-values selection-key-values">${keyValue('계산 ETA', calculatedEtaText(selected))}${keyValue('차량', state.data.vehicle?.plate)}${keyValue('장착 단말', '미확인')}</dl><div class="selection-actions"><a class="button primary" href="#/control">단말 관제 보기</a><a class="button" href="#/customer">고객 보기</a></div></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>조회 조건을 바꿔 주세요.</p></div>';
}

function renderControl(visible, selected) {
  byId('list-count').textContent = `${visible.length}곳`;
  byId('terminal-list').innerHTML = visible.map(delivery => `
    <button type="button" class="terminal-row${delivery.id === state.selectedId ? ' selected' : ''}" data-select="${escapeHtml(delivery.id)}" aria-pressed="${delivery.id === state.selectedId}">
      <span class="terminal-row-head"><strong>${delivery.sequence}. ${escapeHtml(delivery.name)}</strong>${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}</span>
      <span class="terminal-row-meta">${escapeHtml(delivery.address)}</span>
      <span class="terminal-row-eta">${escapeHtml(publishedEtaText(delivery))}</span>
    </button>`).join('');
  byId('eta-panel').hidden = !selected;
  byId('selected-heading').innerHTML = selected ? `
    <div class="terminal-title"><p class="eyebrow">선택 배송 ${escapeHtml(selected.id)}</p><h2>${escapeHtml(selected.name)}</h2><p>${escapeHtml(selected.address)}</p></div><div class="status-meta">${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}<span>장착 단말 미확인</span></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2></div>';
  if (!selected) {
    byId('eta-panel').innerHTML = '';
    byId('delivery-timeline').innerHTML = '';
    byId('event-list').innerHTML = '';
    byId('notification-list').innerHTML = '';
    byId('preview-sidebar').innerHTML = '';
    return;
  }
  byId('eta-panel').innerHTML = `
    <div class="panel-heading"><h2 id="eta-heading">ETA 배송 진행</h2><span class="muted">${escapeHtml(state.data.simClock || '시각 미확인')} 기준</span></div>
    <div class="eta-grid"><div class="eta-primary"><p class="eyebrow">${selected.status === 'done' ? '배송 완료 시각' : '고객 공식 ETA'}</p><p class="eta-value">${escapeHtml(etaDisplay(selected))}</p><p class="muted">${selected.status === 'done' ? '배송 완료 기록' : selected.ordered && selected.officialEta?.updatedAt ? `${escapeHtml(selected.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</p></div><div class="eta-secondary"><dl class="key-values">${keyValue('계산 ETA', calculatedEtaText(selected))}${keyValue('현재 순서', `${selected.sequence}번째`)}${keyValue('실제 도착', selected.arrivedAt)}${keyValue('배송 완료', selected.completedAt)}</dl></div></div>`;
  byId('delivery-timeline').innerHTML = selected.timeline.length
    ? selected.timeline.map(item => `<li><time class="event-time">${escapeHtml(item.time || '')}</time><div class="event-copy"><span class="event-kind">${escapeHtml(({ done: '완료', current: '현재 단계', pending: '예정' })[item.state] || '미확인')}</span><h3>${escapeHtml(item.label)}</h3></div></li>`).join('')
    : '<li class="empty-state">제공된 고객 타임라인이 없습니다.</li>';
  byId('event-list').innerHTML = state.data.events.length
    ? state.data.events.map(event => `<li><time class="event-time">${escapeHtml(event.time || '')}</time><div class="event-copy"><span class="event-kind">${escapeHtml(({ system: '시나리오', notify: '알림 문구', eta: 'ETA 변경', stage: '배송 단계', info: '진행 정보', incident: '사건' })[event.type] || '진행 정보')}</span><p>${escapeHtml(event.message)}</p></div></li>`).join('')
    : '<li class="empty-state">제공된 사건이 없습니다.</li>';
  byId('notification-list').innerHTML = '<p class="notification-description">시뮬레이션이 만든 시연 문구입니다. 실제 발송·전달·수신 결과가 아닙니다.</p>' + (selected.notices.length
    ? selected.notices.map(notice => `<section class="notification-item"><div class="notification-labels">${notice.time ? `<span class="muted">${escapeHtml(notice.time)}</span>` : ''}</div><h3>${escapeHtml(notice.title)}</h3><p class="notification-copy">${escapeHtml(notice.body)}</p></section>`).join('')
    : '<div class="empty-state compact"><strong>제공된 알림 문구가 없습니다.</strong></div>');
  renderVehiclePanel(selected);
}

function renderVehiclePanel(selected) {
  const vehicle = state.data.vehicle;
  byId('preview-sidebar').innerHTML = `
    <section class="panel"><div class="panel-heading"><h2>운행 차량</h2>${badge(phaseLabels[state.data.phase] || '미확인', state.data.phase === 'done' ? 'green' : state.data.phase === 'delivering' ? 'blue' : 'neutral')}</div>
      <div class="device-preview-body"><dl class="key-values">${keyValue('차량', vehicle?.plate)}${keyValue('기사', vehicle?.driver)}${keyValue('권역', vehicle?.region)}${keyValue('장착 단말', '미확인')}</dl><p class="footer-note">8개 배송은 이 차량 1대의 정차지입니다.</p></div>
    </section>
    <section class="panel route-actions"><div class="panel-heading"><h2>배송 순서 제어</h2><span class="muted">원본 명령</span></div><div class="route-actions-body"><button class="button" type="button" data-command="reorder" data-stop-id="${escapeHtml(selected.id)}" data-dir="up" ${selected.status !== 'pending' ? 'disabled' : ''}>앞으로</button><button class="button" type="button" data-command="reorder" data-stop-id="${escapeHtml(selected.id)}" data-dir="down" ${selected.status !== 'pending' ? 'disabled' : ''}>뒤로</button><button class="button subtle" type="button" data-command="toggle_skip" data-stop-id="${escapeHtml(selected.id)}" ${['current', 'done'].includes(selected.status) ? 'disabled' : ''}>${selected.status === 'skipped' ? '배송 복원' : '배송 건너뜀'}</button></div></section>`;
}

function renderCustomer(visible, selected) {
  const select = byId('customer-delivery');
  select.disabled = visible.length === 0;
  select.innerHTML = visible.length ? visible.map(delivery => `<option value="${escapeHtml(delivery.id)}">${delivery.sequence}. ${escapeHtml(delivery.name)}</option>`).join('') : '<option>조회된 배송 없음</option>';
  if (selected) select.value = selected.id;
  byId('customer-context').innerHTML = selected ? `<dl class="key-values customer-context-values">${keyValue('배송 순서', `${selected.sequence}번째`)}${keyValue('배송 상태', selected.customerStatus.label)}${keyValue('차량', state.data.vehicle?.plate)}${keyValue('장착 단말', '미확인')}</dl><p class="footer-note">운영 화면과 같은 고객 공식 ETA를 사용합니다.</p>` : '';
  if (!selected) {
    byId('customer-display').innerHTML = '<section class="panel empty-state"><h2>선택할 배송이 없습니다.</h2></section>';
    return;
  }
  if (!selected.ordered) {
    byId('customer-display').innerHTML = `<section class="panel customer-surface"><div class="customer-surface-header"><strong>미트박스</strong><span>배송 안내</span></div><div class="customer-card"><p class="eyebrow">${escapeHtml(selected.name)}</p>${badge('주문 전')}<h3>주문 접수 전입니다.</h3><p class="customer-message">시나리오 제어에서 주문을 접수하면 배송 안내가 시작됩니다.</p></div></section>`;
    return;
  }
  const customerEta = selected.status === 'done' ? selected.completedAt || '미확인' : selected.status === 'skipped' ? '미확인' : publishedEtaText(selected);
  byId('customer-display').innerHTML = `<section class="panel customer-surface" aria-label="${escapeHtml(selected.name)} 고객 안내"><div class="customer-surface-header"><strong>미트박스</strong><span>배송 안내</span></div><div class="customer-card"><p class="eyebrow">${escapeHtml(selected.name)}</p>${badge(selected.customerStatus.label, selected.customerStatusTone)}<h3>${escapeHtml(customerHeadline(selected))}</h3><p class="eyebrow">${selected.status === 'done' ? '배송 완료 시각' : '도착 예정 시각'}</p><strong class="customer-eta">${escapeHtml(customerEta)}</strong><p class="muted">${selected.officialEta?.updatedAt ? `${escapeHtml(selected.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</p>${selected.notices.at(-1) ? `<p class="customer-message">${escapeHtml(selected.notices.at(-1).body)}</p>` : '<p class="customer-message">제공된 안내 문구가 없습니다.</p>'}<p class="footer-note">시연용 고객 안내</p></div></section>`;
}

function renderTabs() {
  document.querySelectorAll('#page-control [data-tab]').forEach(button => {
    const selected = button.dataset.tab === state.tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(`panel-${button.dataset.tab}`).hidden = !selected;
  });
}

window.addEventListener('hashchange', () => {
  state.page = pageFromHash(location.hash);
  if (location.hash !== `#/${state.page}`) history.replaceState(null, '', `#/${state.page}`);
  render();
  byId('page-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
document.addEventListener('click', event => {
  const selection = event.target.closest('[data-select]');
  if (selection) {
    state.selectedId = selection.dataset.select;
    render();
  }
  const command = event.target.closest('[data-command]');
  if (command && command.closest('#preview-sidebar') && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: command.dataset.command, stopId: command.dataset.stopId, dir: command.dataset.dir }));
  }
});
byId('delivery-search').addEventListener('input', event => { state.query = event.target.value; render(); });
byId('delivery-status').addEventListener('change', event => { state.status = event.target.value; render(); });
byId('clear-filters').addEventListener('click', () => {
  state.query = '';
  state.status = 'all';
  byId('delivery-search').value = '';
  byId('delivery-status').value = 'all';
  render();
});
byId('customer-delivery').addEventListener('change', event => { state.selectedId = event.target.value; render(); });
byId('toggle-map').addEventListener('click', event => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
  byId('map-preview').hidden = !expanded;
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
  event.currentTarget.textContent = expanded ? '지도 접기' : '지도 펼치기';
});
const tabs = [...document.querySelectorAll('#page-control [data-tab]')];
tabs.forEach((button, index) => {
  button.addEventListener('click', () => { state.tab = button.dataset.tab; renderTabs(); });
  button.addEventListener('keydown', event => {
    const offsets = { ArrowRight: 1, ArrowLeft: -1 };
    let next = offsets[event.key] === undefined ? null : (index + offsets[event.key] + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    state.tab = tabs[next].dataset.tab;
    renderTabs();
    tabs[next].focus();
  });
});
byId('retry-connection').addEventListener('click', start);
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', `${document.querySelector('.app-header').offsetHeight}px`)).observe(document.querySelector('.app-header'));

history.replaceState(null, '', `#/${state.page}`);
start();
