import { adaptSimulation, calculatedEtaText, publishedEtaText } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { deliveryLinks } from './delivery-review.mjs';
import { mountRouteEditor } from './route-editor.mjs';

const pages = {
  deliveries: { title: '배송 현황', eyebrow: '차량 1대의 배송 8곳', description: '배송 순서와 고객 공식 ETA, 계산 ETA를 함께 확인합니다.' },
  manage: { title: '배송 관리', eyebrow: '운영 뷰어', description: '차량의 배송 순서를 편집하고 사건 이력과 고객 알림 문구를 확인합니다.' },
  control: { title: '배송 관제', eyebrow: '운영 뷰어', description: '선택 배송의 ETA와 배송 진행을 지도 옆에서 확인합니다.' },
};
const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '건너뜀' };
const state = {
  page: pageFromHash(location.hash),
  data: null,
  selectedId: new URLSearchParams(location.search).get('id'),
  query: '',
  status: 'all',
  tab: 'events',
  connected: false,
};
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const badge = (text, color = 'neutral') => `<span class="badge ${color}">${escapeHtml(text)}</span>`;
const keyValue = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '미확인')}</dd></div>`;

const scenarioTools = mountDemoShell({ viewer: 'operator', onSend: (type, extra) => simulation.send(type, extra) });
const routeEditor = mountRouteEditor({ element: byId('route-editor'), onSend: (type, extra) => simulation.send(type, extra), onSelect: id => { state.selectedId = id; render(); } });
if (location.hash === '#/customer') location.replace(deliveryLinks(state.selectedId).mobile);
scenarioTools.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    const next = adaptSimulation(raw);
    state.data = next;
    state.connected = true;
    render();
  },
  onStatus(connected, message) {
    state.connected = connected;
    byId('connection-panel').hidden = connected;
    byId('live-pages').hidden = !connected;
    byId('connection-title').textContent = message;
    byId('connection-detail').textContent = connected ? '' : '연결이 복구되면 같은 진행 상태를 이어갑니다.';
    scenarioTools.update(state.data, connected);
    if (state.data) routeEditor.update(state.data, state.selectedId, connected);
  },
  onError: message => { if (!routeEditor.showError(message)) scenarioTools.showError(message); },
});

function pageFromHash(hash) {
  const page = hash.replace(/^#\//, '');
  return Object.hasOwn(pages, page) ? page : 'deliveries';
}

function visibleDeliveries() {
  if (!state.data) return [];
  const needle = state.query.trim().toLocaleLowerCase('ko-KR');
  return state.data.deliveries.filter(delivery => {
    const search = [delivery.id, delivery.name, delivery.address].some(value => value.toLocaleLowerCase('ko-KR').includes(needle));
    return search && (state.status === 'all' || delivery.status === state.status);
  });
}

function selectedDelivery(visible = state.page === 'deliveries' ? visibleDeliveries() : state.data?.deliveries || []) {
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
  const selected = selectedDelivery();
  state.selectedId = selected?.id ?? null;
  renderPage();
  renderSummary();
  renderReview(selected);
  renderDeliveries(visible, selected);
  renderControl(state.data.deliveries, selected);
  routeEditor.update(state.data, selected?.id, state.connected);
  renderTabs();
  scenarioTools.update(state.data, state.connected);
}

function renderPage() {
  const page = pages[state.page];
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== state.page; });
  document.querySelectorAll('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('page-heading').textContent = page.title;
  byId('page-eyebrow').textContent = page.eyebrow;
  byId('page-description').textContent = page.description;
  document.title = `${page.title} · 미트박스 TMS 시연`;
}

function renderSummary() {
  const deliveries = state.data.deliveries;
  byId('summary-counts').innerHTML = `
    <div><span>차량</span><strong>${state.data.vehicle ? 1 : 0}</strong></div>
    <div><span>배송</span><strong>${deliveries.length}</strong></div>
    <div><span>완료</span><strong>${deliveries.filter(item => item.status === 'done').length}</strong></div>`;
}

function renderReview(selected) {
  scenarioTools.select(selected?.id);
  const url = new URL(location.href);
  if (selected && url.searchParams.get('id') !== selected.id) {
    url.searchParams.set('id', selected.id);
    history.replaceState(null, '', url);
  }
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
    <div class="selection-body"><p class="eyebrow">${selected.sequence}번째 배송</p><h3>${escapeHtml(selected.name)}</h3><p class="eyebrow">${selected.status === 'done' ? '배송 완료 시각' : '고객 공식 ETA'}</p><strong class="selection-eta">${escapeHtml(etaDisplay(selected))}</strong><p class="muted">${selected.status === 'done' ? `실제 도착 ${escapeHtml(selected.arrivedAt || '미확인')}` : selected.ordered && selected.officialEta?.updatedAt ? `${escapeHtml(selected.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</p><dl class="key-values selection-key-values">${keyValue('계산 ETA', calculatedEtaText(selected))}${keyValue('차량', state.data.vehicle?.plate)}${keyValue('장착 단말', '미확인')}</dl><div class="selection-actions"><a class="button primary" href="#/control">배송 관제</a><a class="button" href="#/manage">배송 관리</a></div></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>조회 조건을 바꿔 주세요.</p></div>';
}

function renderControl(visible, selected) {
  const select = byId('monitor-delivery');
  const options = visible.map(delivery => `<option value="${escapeHtml(delivery.id)}">${delivery.sequence}. ${escapeHtml(delivery.name)}</option>`).join('');
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = selected?.id || '';
  byId('manage-selected-name').textContent = selected ? `${selected.name} · 배송 이력` : '선택 배송 이력';
  byId('eta-panel').hidden = !selected;
  byId('selected-heading').innerHTML = selected ? `
    <div class="terminal-title"><p class="eyebrow">${escapeHtml(state.data.vehicle?.plate)} · ${selected.sequence}번째 배송</p><h2>${escapeHtml(selected.name)}</h2><p>${escapeHtml(selected.address)}</p></div><div class="status-meta">${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}</div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2></div>';
  if (!selected) {
    byId('eta-panel').innerHTML = '';
    byId('delivery-timeline').innerHTML = '';
    byId('event-list').innerHTML = '';
    byId('notification-list').innerHTML = '';
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
}

function renderTabs() {
  document.querySelectorAll('#page-manage [data-tab]').forEach(button => {
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
byId('monitor-delivery').addEventListener('change', event => { state.selectedId = event.target.value; render(); });
const tabs = [...document.querySelectorAll('#page-manage [data-tab]')];
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
byId('retry-connection').addEventListener('click', () => location.reload());
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
history.replaceState(null, '', `#/${state.page}`);
