import { adaptSimulation, calculatedEtaText, publishedEtaText } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { deliveryLinks } from './delivery-review.mjs';
import { mountRouteEditor } from './route-editor.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { operatorRoute, orderStage, filterOrders, resolveDeliverySelection } from './operations-model.mjs';

const pages = {
  orders: { title: '주문 관리', description: '접수 주문 · 상품 구성 · 배송 연결' },
  deliveries: { title: '배송 목록', description: '배송 순서 · 고객 공식 ETA · 계산 ETA' },
  control: { title: '배송 관제', description: '배송 진행 · 사건 이력 · 배송 관리' },
};
const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const orderLabels = { preparing: '출고 준비', shipping: '배송 중', done: '완료', held: '보류' };
let saved = {};
try { saved = JSON.parse(sessionStorage.getItem('meatbox.operator.filters')) || {}; } catch {}
const state = {
  ...operatorRoute(location.hash),
  data: null,
  selectedId: new URLSearchParams(location.search).get('id'),
  query: typeof saved.query === 'string' ? saved.query : '',
  status: ['all', ...Object.keys(statusLabels)].includes(saved.status) ? saved.status : 'all',
  orderQuery: typeof saved.orderQuery === 'string' ? saved.orderQuery : '',
  orderStatus: ['all', ...Object.keys(orderLabels)].includes(saved.orderStatus) ? saved.orderStatus : 'all',
  tab: 'events',
  connected: false,
};
const byId = id => document.getElementById(id);
document.querySelectorAll('[data-field-icon]').forEach(element => { element.innerHTML = referenceIcon(element.dataset.fieldIcon); });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const badge = (text, color = 'neutral') => `<span class="badge ${color}">${escapeHtml(text)}</span>`;
const keyValue = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '미확인')}</dd></div>`;

const scenarioTools = mountDemoShell({ viewer: 'operator', onSend: (type, extra) => simulation.send(type, extra) });
const routeEditor = mountRouteEditor({ element: byId('route-editor'), onSend: (type, extra) => simulation.send(type, extra), onSelect: id => { state.selectedId = id; render(); } });
if (location.hash === '#/customer') location.replace(deliveryLinks(state.selectedId).mobile);
if (location.hash === '#/driver') location.replace(deliveryLinks(state.selectedId).driver);
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

function visibleDeliveries() {
  if (!state.data) return [];
  const needle = state.query.trim().toLocaleLowerCase('ko-KR');
  return state.data.deliveries.filter(delivery => {
    const search = [delivery.id, delivery.name, delivery.address].some(value => value.toLocaleLowerCase('ko-KR').includes(needle));
    return search && (state.status === 'all' || delivery.status === state.status);
  });
}

function selectedDelivery() {
  return resolveDeliverySelection(state.data, state.selectedId);
}

// Preserve keyboard position when live values change inside interactive lists/cards.
function renderInteractiveContent(element, markup) {
  if (element.innerHTML === markup) return;
  const focused = element.contains(document.activeElement) ? document.activeElement : null;
  const attribute = ['data-select', 'data-order-select', 'data-order-delivery', 'href'].find(name => focused?.hasAttribute(name));
  const value = attribute ? focused.getAttribute(attribute) : null;
  element.innerHTML = markup;
  if (attribute) element.querySelector(`[${attribute}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
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
  if (selected) state.selectedId = selected.id;
  renderPage();
  renderSummary();
  renderReview(selected);
  renderDeliveries(visible, selected);
  renderOrders();
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
  try {
    sessionStorage.setItem('meatbox.operator.page', state.page);
    sessionStorage.setItem('meatbox.operator.filters', JSON.stringify({ query: state.query, status: state.status, orderQuery: state.orderQuery, orderStatus: state.orderStatus }));
  } catch {}
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
  scenarioTools.select(state.selectedId);
  const url = new URL(location.href);
  if (selected && url.searchParams.get('id') !== selected.id) {
    url.searchParams.set('id', selected.id);
    history.replaceState(null, '', url);
  }
}

function renderDeliveries(visible, selected) {
  byId('delivery-count').textContent = `${visible.length}건`;
  byId('delivery-empty').hidden = visible.length > 0;
  renderInteractiveContent(byId('delivery-rows'), visible.map(delivery => `
    <tr class="${delivery.id === state.selectedId ? 'selected' : ''}">
      <td><button type="button" class="delivery-select" data-select="${escapeHtml(delivery.id)}" aria-pressed="${delivery.id === state.selectedId}"><strong>${delivery.sequence}. ${escapeHtml(delivery.name)}</strong><span>${escapeHtml(delivery.address)}</span></button></td>
      <td>${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}</td>
      <td><strong>${escapeHtml(publishedEtaText(delivery))}</strong><small>${delivery.ordered && delivery.officialEta?.updatedAt ? `${escapeHtml(delivery.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</small></td>
      <td><strong>${escapeHtml(calculatedEtaText(delivery))}</strong><small>계산 ETA</small></td>
      <td><strong>${escapeHtml(delivery.arrivedAt || '미확인')}</strong><small>완료 ${escapeHtml(delivery.completedAt || '미확인')}</small></td>
    </tr>`).join(''));
  renderInteractiveContent(byId('delivery-selection'), selected ? `
    <div class="panel-heading"><h2>선택 배송</h2>${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}</div>
    <div class="selection-body">${visible.some(item => item.id === selected.id) ? '' : '<p class="selection-filter-note">선택한 배송은 현재 조회 조건에 포함되지 않습니다.</p>'}<p class="eyebrow">${selected.sequence}번째 배송</p><h3>${escapeHtml(selected.name)}</h3><p class="eyebrow">${selected.status === 'done' ? '배송 완료 시각' : '고객 공식 ETA'}</p><strong class="selection-eta">${escapeHtml(etaDisplay(selected))}</strong><p class="muted">${selected.status === 'done' ? `실제 도착 ${escapeHtml(selected.arrivedAt || '미확인')}` : selected.ordered && selected.officialEta?.updatedAt ? `${escapeHtml(selected.officialEta.updatedAt)} 갱신` : '갱신 시각 미확인'}</p><dl class="key-values selection-key-values">${keyValue('계산 ETA', calculatedEtaText(selected))}${keyValue('차량', state.data.vehicle?.plate)}${keyValue('변경 사유', selected.ordered ? selected.officialEta?.reason || '변경 없음' : '주문 접수 전')}</dl><div class="selection-actions"><a class="button primary" href="#/control">배송 관제</a><a class="button" href="#/control/manage">배송 관리</a></div></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>배송 데이터를 확인해 주세요.</p></div>');
}

function renderControl(visible, selected) {
  const current = visible.find(delivery => delivery.status === 'current');
  byId('monitor-count').textContent = `${visible.length}곳`;
  byId('monitor-detail').hidden = !selected;
  byId('monitor-current').hidden = !current;
  byId('monitor-current-detail').hidden = !current || current.id === selected?.id;
  const list = byId('monitor-deliveries');
  const rows = visible.map(delivery => {
    const isSelected = delivery.id === selected?.id;
    const timeLabel = delivery.status === 'done' ? '완료 시각' : delivery.ordered ? '도착 예정' : '계산 ETA';
    const time = delivery.ordered ? etaDisplay(delivery) : calculatedEtaText(delivery);
    return `<li><button type="button" class="monitor-stop" data-monitor-select="${escapeHtml(delivery.id)}" aria-pressed="${isSelected}"><span class="monitor-stop-number">${delivery.sequence}</span><span class="monitor-stop-main"><strong>${escapeHtml(delivery.name)}</strong><span class="monitor-stop-status">${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}${isSelected ? '<span>선택</span>' : ''}</span></span><span class="monitor-stop-time"><small>${timeLabel}</small><strong>${escapeHtml(time)}</strong></span></button></li>`;
  }).join('') || '<li class="empty-state">배송지가 없습니다.</li>';
  if (list.innerHTML !== rows) {
    const focusedId = document.activeElement?.dataset.monitorSelect;
    list.innerHTML = rows;
    if (focusedId) list.querySelector(`[data-monitor-select="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }
  byId('manage-selected-name').textContent = selected ? `${selected.name} · 배송 이력` : '선택 배송 이력';
  byId('eta-panel').hidden = !selected;
  byId('monitor-selected-name').textContent = selected?.name || '';
  byId('monitor-selected-status').innerHTML = selected ? badge(statusLabels[selected.status] || '미확인', selected.statusTone) : '';
  byId('monitor-selected-meta').textContent = selected ? `${state.data.vehicle?.plate || '차량 미확인'} · ${selected.sequence}번째 배송` : '';
  byId('monitor-selected-address').textContent = selected?.address || '';
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
    : '<li class="empty-state">배송 기록이 없습니다.</li>';
  byId('event-list').innerHTML = state.data.events.length
    ? state.data.events.map(event => `<li><time class="event-time">${escapeHtml(event.time || '')}</time><div class="event-copy"><span class="event-kind">${escapeHtml(({ system: '시나리오', notify: '알림 문구', eta: 'ETA 변경', stage: '배송 단계', info: '진행 정보', incident: '사건' })[event.type] || '진행 정보')}</span><p>${escapeHtml(event.message)}</p></div></li>`).join('')
    : '<li class="empty-state">사건 기록이 없습니다.</li>';
  byId('notification-list').innerHTML = '<p class="notification-description">시연용 알림입니다. 실제로 발송되지 않습니다.</p>' + (selected.notices.length
    ? selected.notices.map(notice => `<section class="notification-item"><div class="notification-labels">${notice.time ? `<span class="muted">${escapeHtml(notice.time)}</span>` : ''}</div><h3>${escapeHtml(notice.title)}</h3><p class="notification-copy">${escapeHtml(notice.body)}</p></section>`).join('')
    : '<div class="empty-state compact"><strong>알림이 없습니다.</strong></div>');
}

function renderTabs() {
  document.querySelectorAll('[data-control-tab]').forEach(button => {
    const selected = button.dataset.controlTab === state.controlTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(button.getAttribute('aria-controls')).hidden = !selected;
  });
  document.querySelectorAll('#page-control [data-tab]').forEach(button => {
    const selected = button.dataset.tab === state.tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(`panel-${button.dataset.tab}`).hidden = !selected;
  });
}

window.addEventListener('hashchange', () => {
  Object.assign(state, operatorRoute(location.hash));
  normalizeRoute();
  render();
  byId('page-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
document.addEventListener('click', event => {

  const monitorSelection = event.target.closest('[data-monitor-select]');
  if (monitorSelection) showMonitorDelivery(monitorSelection.dataset.monitorSelect);
  const selection = event.target.closest('[data-select]');
  if (selection) {
    state.selectedId = selection.dataset.select;
    render();
  }

});
byId('delivery-search').value = state.query;
byId('delivery-status').value = state.status;
byId('order-search').value = state.orderQuery;
byId('order-status').value = state.orderStatus;
byId('delivery-search').addEventListener('input', event => { state.query = event.target.value; render(); });
byId('delivery-status').addEventListener('change', event => { state.status = event.target.value; render(); });
byId('clear-filters').addEventListener('click', () => {
  state.query = '';
  state.status = 'all';
  byId('delivery-search').value = '';
  byId('delivery-status').value = 'all';
  render();
});
function showMonitorDelivery(id) {
  if (!state.data?.deliveries.some(delivery => delivery.id === id)) return;
  state.selectedId = id;
  render();
  byId('selected-heading').focus({ preventScroll: true });
  byId('selected-heading').scrollIntoView({ block: 'nearest' });
}
byId('monitor-back').addEventListener('click', () => {
  state.controlTab = 'monitor';
  history.replaceState(null, '', '#/control');
  renderTabs();
  byId('monitor-deliveries').querySelector(`[data-monitor-select="${CSS.escape(state.selectedId || '')}"]`)?.focus();
});
document.querySelectorAll('[data-monitor-current]').forEach(button => button.addEventListener('click', () => {
  showMonitorDelivery(state.data?.deliveries.find(delivery => delivery.status === 'current')?.id);
}));
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
byId('retry-connection').addEventListener('click', () => location.reload());
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
normalizeRoute();

function normalizeRoute() {
  const hash = state.page === 'control' && state.controlTab === 'management' ? '#/control/manage' : `#/${state.page}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

const controlTabs = [...document.querySelectorAll('[data-control-tab]')];
controlTabs.forEach((button, index) => {
  const activate = target => {
    state.controlTab = target.dataset.controlTab;
    const hash = state.controlTab === 'management' ? '#/control/manage' : '#/control';
    if (location.hash !== hash) history.pushState(null, '', hash);
    renderTabs();
  };
  button.addEventListener('click', () => activate(button));
  button.addEventListener('keydown', event => {
    const offsets = { ArrowRight: 1, ArrowLeft: -1 };
    let next = offsets[event.key] === undefined ? null : (index + offsets[event.key] + controlTabs.length) % controlTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = controlTabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    activate(controlTabs[next]);
    controlTabs[next].focus();
  });
});
byId('order-search').addEventListener('input', event => { state.orderQuery = event.target.value; render(); });
byId('order-status').addEventListener('change', event => { state.orderStatus = event.target.value; render(); });
byId('clear-order-filters').addEventListener('click', () => {
  state.orderQuery = ''; state.orderStatus = 'all';
  byId('order-search').value = ''; byId('order-status').value = 'all';
  render();
});

function renderOrders() {
  const orders = filterOrders(state.data.deliveries, state.orderQuery, state.orderStatus);
  const selected = state.data.deliveries.find(order => order.id === state.selectedId && order.ordered);
  byId('order-count').textContent = `${orders.length}건`;
  byId('order-empty').hidden = orders.length > 0;
  renderInteractiveContent(byId('order-rows'), orders.map(order => `
    <tr class="${order.id === selected?.id ? 'selected' : ''}">
      <td><button type="button" class="delivery-select" data-order-select="${escapeHtml(order.id)}" aria-pressed="${order.id === selected?.id}"><strong>${escapeHtml(order.name)}</strong><span>${escapeHtml(order.address)}</span></button></td>
      <td>${badge(order.customerStatus.label, order.customerStatusTone)}</td>
      <td>${escapeHtml(order.items[0]?.name || '상품 미확인')}${order.items.length > 1 ? `<small>외 ${order.items.length - 1}개 상품</small>` : ''}</td>
      <td>${escapeHtml(order.boxes ?? '미확인')}</td>
      <td><a class="button subtle" data-order-delivery="${escapeHtml(order.id)}" href="#/deliveries">배송 보기</a></td>
    </tr>`).join(''));
  renderInteractiveContent(byId('order-selection'), selected ? `
    <div class="panel-heading"><h2>주문 상세</h2>${badge(orderLabels[orderStage(selected)], selected.customerStatusTone)}</div>
    <div class="selection-body">${orders.some(item => item.id === selected.id) ? '' : '<p class="selection-filter-note">선택한 주문은 현재 조회 조건에 포함되지 않습니다.</p>'}<h3>${escapeHtml(selected.name)}</h3><p class="muted">${escapeHtml(selected.address)}</p>
      <ul class="order-items">${selected.items.map(item => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.opt || '')}</span><span>${escapeHtml(item.qty ?? '미확인')}박스</span></li>`).join('') || '<li>상품 구성이 확인되지 않았습니다.</li>'}</ul>
      <dl class="key-values selection-key-values">${keyValue('전체 수량', selected.boxes === null ? '미확인' : `${selected.boxes}박스`)}${keyValue('배송 순서', `${selected.sequence}번째`)}${keyValue('차량', state.data.vehicle?.plate)}</dl>
      <div class="selection-actions"><a class="button primary" data-order-delivery="${escapeHtml(selected.id)}" href="#/deliveries">배송 보기</a></div>
    </div>` : '<div class="empty-state"><h2>선택한 배송의 주문 접수 전입니다.</h2><p>목록에서 접수된 주문을 선택해 상세를 확인하세요.</p></div>');
}
document.addEventListener('click', event => {
  const selection = event.target.closest('[data-order-select]');
  if (selection) { state.selectedId = selection.dataset.orderSelect; render(); }
  const link = event.target.closest('[data-order-delivery]');
  if (link) {
    state.selectedId = link.dataset.orderDelivery;
    render();
  }
});
