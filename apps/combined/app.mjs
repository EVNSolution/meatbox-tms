import { adaptSimulation, calculatedEtaText, publishedEtaText } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { deliveryLinks } from './delivery-review.mjs';
import { mountOrderPlanning } from './order-planning.mjs';
import { mountRouteEditor } from './route-editor.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { filterFleetDeliveries, normalizeVehicleFilter, operatorRoute, resolveDeliverySelection } from './operations-model.mjs';

const pages = {
  orders: { title: '주문 관리', description: '접수 주문과 차량별 배송량' },
  deliveries: { title: '배송 목록', description: '전체 차량의 배송지 현황' },
  control: { title: '배송 관제', description: '선택 차량의 배송 진행과 고객 알림, 배송 관리' },
};
const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
let saved = {};
try { saved = JSON.parse(sessionStorage.getItem('meatbox.operator.filters')) || {}; } catch {}
const state = {
  ...operatorRoute(location.hash),
  data: null,
  selectedId: new URLSearchParams(location.search).get('id'),
  query: typeof saved.query === 'string' ? saved.query : '',
  status: ['all', ...Object.keys(statusLabels)].includes(saved.status) ? saved.status : 'all',
  vehicleId: typeof saved.vehicleId === 'string' ? saved.vehicleId : 'all',
  tab: 'notifications',
  connected: false,
  pendingNotice: null,
  noticeMessage: '',
  noticeError: false,
};
const byId = id => document.getElementById(id);
document.querySelectorAll('[data-field-icon]').forEach(element => { element.innerHTML = referenceIcon(element.dataset.fieldIcon); });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const badge = (text, color = 'neutral') => `<span class="badge ${color}">${escapeHtml(text)}</span>`;
const keyValue = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '미확인')}</dd></div>`;

const scenarioTools = mountDemoShell({ viewer: 'operator', onSend: (type, extra) => simulation.send(type, extra) });
const routeEditor = mountRouteEditor({ element: byId('route-editor'), onSend: (type, extra) => simulation.send(type, extra), onSelect: id => { state.selectedId = id; render(); } });
const orderPlanning = mountOrderPlanning({ element: byId('order-planning'), onSelect: id => { state.selectedId = id; render(); } });
if (location.hash === '#/customer') location.replace(deliveryLinks(state.selectedId).mobile);
if (location.hash === '#/driver') location.replace(deliveryLinks(state.selectedId).driver);
scenarioTools.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    const next = adaptSimulation(raw);
    if (state.pendingNotice) {
      const delivered = next.fleetDeliveries?.find(item => item.id === state.pendingNotice.stopId)?.notices
        ?.some(item => item.body === state.pendingNotice.body && !state.pendingNotice.seenIds.has(item.id));
      if (delivered) {
        state.pendingNotice = null;
        state.noticeMessage = '고객 화면에 안내 팝업을 전달했습니다.';
        state.noticeError = false;
      }
    }
    state.data = next;
    state.connected = true;
    render();
  },
  onStatus(connected, message) {
    state.connected = connected;
    if (!connected && state.pendingNotice) {
      state.pendingNotice = null; state.noticeMessage = '연결이 끊겨 안내를 전달하지 못했습니다.'; state.noticeError = true;
    }
    byId('connection-panel').hidden = connected;
    byId('live-pages').hidden = !connected;
    byId('connection-title').textContent = message;
    byId('connection-detail').textContent = connected ? '' : '연결이 복구되면 같은 진행 상태를 이어갑니다.';
    scenarioTools.update(state.data, connected);
    if (state.data && !connected) render();
  },
  onError: message => {
    if (state.pendingNotice) {
      state.pendingNotice = null; state.noticeMessage = message; state.noticeError = true; render();
    } else if (!routeEditor.showError(message)) scenarioTools.showError(message);
  },
});

function visibleDeliveries() {
  if (!state.data) return [];
  const needle = state.query.trim().toLocaleLowerCase('ko-KR');
  return filterFleetDeliveries(state.data.fleetDeliveries || state.data.deliveries, {
    query: needle, status: state.status, vehicleId: state.vehicleId,
  });
}

function selectedDelivery() {
  return resolveDeliverySelection(state.data, state.selectedId);
}

// Preserve keyboard position when live values change inside interactive lists/cards.
function renderInteractiveContent(element, markup) {
  if (element.innerHTML === markup) return;
  const focused = element.contains(document.activeElement) ? document.activeElement : null;
  const attribute = ['data-select', 'data-monitor-select', 'href'].find(name => focused?.hasAttribute(name));
  const value = attribute ? focused.getAttribute(attribute) : null;
  element.innerHTML = markup;
  if (attribute) element.querySelector(`[${attribute}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

function etaDisplay(delivery) {
  if (delivery.status === 'done') return delivery.completedAt || '미확인';
  if (delivery.status === 'skipped') return '미확인';
  return delivery.preciseTimeText || calculatedEtaText(delivery);
}

function render() {
  if (!state.data) return;
  state.vehicleId = normalizeVehicleFilter(state.vehicleId, state.data.fleetVehicles);
  const visible = visibleDeliveries();
  const selected = selectedDelivery();
  if (selected) state.selectedId = selected.id;
  renderPage();
  renderSummary();
  renderReview(selected);
  renderDeliveries(visible, selected);
  orderPlanning.update(state.data, state.selectedId);
  renderControl(selected);
  routeEditor.update(routeEditorState(selected), selected?.id, state.connected);
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
    sessionStorage.setItem('meatbox.operator.filters', JSON.stringify({ query: state.query, status: state.status, vehicleId: state.vehicleId }));
  } catch {}
  byId('page-description').textContent = page.description;
}

function renderSummary() {
  const deliveries = state.data.fleetDeliveries || state.data.deliveries;
  byId('summary-counts').innerHTML = `
    <div><span>차량</span><strong>${state.data.fleetVehicles?.length || (state.data.vehicle ? 1 : 0)}</strong></div>
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
  const total = (state.data.fleetDeliveries || state.data.deliveries).length;
  const vehicleSelect = byId('delivery-vehicle');
  const options = `<option value="all">전체 차량</option>${(state.data.fleetVehicles || []).map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate)} ${escapeHtml(vehicle.driver)}</option>`).join('')}`;
  if (vehicleSelect.innerHTML !== options) vehicleSelect.innerHTML = options;
  vehicleSelect.value = state.vehicleId;
  byId('delivery-count').textContent = `${visible.length} / ${total}건`;
  byId('delivery-empty').hidden = visible.length > 0;
  renderInteractiveContent(byId('delivery-rows'), visible.map(delivery => `
    <tr class="${delivery.id === state.selectedId ? 'selected' : ''}" data-delivery-row="${escapeHtml(delivery.id)}">
      <td title="${escapeHtml(delivery.vehicle?.plate || '차량 미확인')}">${escapeHtml(delivery.vehicle?.plate || '미확인')}</td>
      <td title="${escapeHtml(delivery.vehicle?.driver || '배송원 미확인')}">${escapeHtml(delivery.vehicle?.driver || '미확인')}</td>
      <td>${escapeHtml(delivery.sequence)}</td>
      <td><button type="button" class="delivery-select" data-select="${escapeHtml(delivery.id)}" aria-pressed="${delivery.id === state.selectedId}" title="${escapeHtml(delivery.name)}">${escapeHtml(delivery.name)}</button></td>
      <td class="fleet-address" title="${escapeHtml(delivery.address)}">${escapeHtml(delivery.address)}</td>
      <td>${escapeHtml(delivery.boxes ?? '미확인')}</td>
      <td>${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}</td>
      <td>${escapeHtml(delivery.preciseTimeText || calculatedEtaText(delivery))}</td>
      <td>${escapeHtml(delivery.customerWindowText || publishedEtaText(delivery))}</td>
      <td>${escapeHtml(delivery.arrivedAt || '미확인')}</td>
      <td>${escapeHtml(delivery.completedAt || '미확인')}</td>
    </tr>`).join(''));
  renderInteractiveContent(byId('delivery-selection'), selected ? `
    <div class="panel-heading"><h2>선택 배송</h2>${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}</div>
    <div class="selection-body">${visible.some(item => item.id === selected.id) ? '' : '<p class="selection-filter-note">선택한 배송은 현재 조회 조건에 포함되지 않습니다.</p>'}<p class="eyebrow">${selected.sequence}번째 배송</p><h3>${escapeHtml(selected.name)}</h3><p class="muted">${escapeHtml(selected.address)}</p><strong class="selection-eta">${escapeHtml(selected.preciseTimeText || calculatedEtaText(selected))}</strong><p class="muted">고객 안내 ${escapeHtml(selected.customerWindowText || publishedEtaText(selected))}</p><dl class="key-values selection-key-values">${keyValue('차량', selected.vehicle?.plate)}${keyValue('배송원', selected.vehicle?.driver)}${keyValue('권역', selected.vehicle?.region)}${keyValue('박스', selected.boxes === null ? '미확인' : `${selected.boxes}박스`)}</dl><section class="delivery-tip"><p class="eyebrow">배송팁</p>${selected.tip ? `<p>${escapeHtml(selected.tip.body)}</p><small>${escapeHtml(selected.tip.author)} (${escapeHtml(selected.tip.updatedAt)})</small>` : '<p class="muted">배송원이 작성한 배송팁이 없습니다.</p>'}</section><div class="selection-actions"><a class="button primary" href="#/control">배송 관제</a><a class="button" href="#/control/manage">배송 관리</a></div></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>배송 데이터를 확인해 주세요.</p></div>');
}

function selectedVehicleRoute(selected) {
  if (!selected) return [];
  return (state.data.fleetDeliveries || state.data.deliveries).filter(delivery => delivery.vehicleId === selected.vehicleId);
}

function routeEditorState(selected) {
  const deliveries = selectedVehicleRoute(selected);
  return { ...state.data, deliveries, vehicle: selected?.vehicle || state.data.vehicle, customerStopId: selected?.vehicle?.live ? state.data.customerStopId : null };
}

function renderControl(selected) {
  const visible = selectedVehicleRoute(selected);
  const current = visible.find(delivery => delivery.status === 'current');
  byId('monitor-count').textContent = `${visible.length}곳`;
  byId('monitor-detail').hidden = !selected;
  byId('monitor-current').hidden = !current;
  const list = byId('monitor-deliveries');
  const rows = visible.map(delivery => {
    const isSelected = delivery.id === selected?.id;
    const timeLabel = delivery.status === 'done' ? '완료 시각' : delivery.ordered ? '도착 예정' : '계산 ETA';
    const time = delivery.ordered ? etaDisplay(delivery) : calculatedEtaText(delivery);
    return `<li><button type="button" class="monitor-stop" data-monitor-select="${escapeHtml(delivery.id)}" aria-pressed="${isSelected}" title="${escapeHtml(delivery.address)}"><span class="monitor-stop-number">${delivery.sequence}</span><strong class="monitor-stop-name">${escapeHtml(delivery.name)}</strong><span class="monitor-stop-status">${badge(statusLabels[delivery.status] || '미확인', delivery.statusTone)}</span><span class="monitor-stop-time"><span class="sr-only">${timeLabel} </span><strong>${escapeHtml(time)}</strong></span></button></li>`;
  }).join('') || '<li class="empty-state">배송지가 없습니다.</li>';
  if (list.innerHTML !== rows) {
    const focusedId = document.activeElement?.dataset.monitorSelect;
    list.innerHTML = rows;
    if (focusedId) list.querySelector(`[data-monitor-select="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }
  byId('eta-panel').hidden = !selected;
  if (!selected) {
    byId('eta-panel').innerHTML = '';
    byId('delivery-timeline').innerHTML = '';
    byId('event-list').innerHTML = '';
    byId('notification-list').innerHTML = '';
    return;
  }
  byId('eta-panel').innerHTML = `
    <div class="panel-heading"><h2 id="eta-heading">ETA 배송 진행</h2><span class="muted">${escapeHtml(state.data.simClock || '시각 미확인')} 기준</span></div>
    <div class="eta-grid"><div class="eta-primary"><p class="eyebrow">운영 ETA</p><p class="eta-value">${escapeHtml(selected.preciseTimeText || calculatedEtaText(selected))}</p></div><div class="eta-secondary"><dl class="key-values eta-facts" aria-label="배송 진행">${keyValue('현재 순서', `${selected.sequence}번째`)}${keyValue('상태', statusLabels[selected.status] || '미확인')}</dl><dl class="key-values eta-facts" aria-label="실제 처리 시각">${keyValue('실제 도착', selected.arrivedAt)}${keyValue('배송 완료', selected.completedAt)}</dl></div></div>`;
  byId('delivery-timeline').innerHTML = selected.timeline.length
    ? selected.timeline.map(item => `<li><time class="event-time"${item.time ? '' : ' aria-label="시각 미확인"'}>${escapeHtml(item.time || '-')}</time><div class="event-copy"><span class="event-kind">${escapeHtml(({ done: '완료', current: '현재 단계', pending: '예정' })[item.state] || '미확인')}</span><h3>${escapeHtml(item.label)}</h3></div></li>`).join('')
    : '<li class="empty-state">배송 기록이 없습니다.</li>';
  const events = selected.vehicle?.live ? state.data.events : [];
  byId('event-list').innerHTML = events.length
    ? events.map(event => `<li><time class="event-time">${escapeHtml(event.time || '-')}</time><div class="event-copy"><span class="event-kind">${escapeHtml(({ notify: '고객 알림', eta: 'ETA 변경', stage: '처리 이력', info: '진행 정보', incident: '사건', driver: '배송 관리' })[event.type] || '진행 정보')}</span><p>${escapeHtml(event.message)}</p></div></li>`).join('')
    : '<li class="empty-state">사건 기록이 없습니다.</li>';
  byId('open-notice-dialog').disabled = !state.connected || !!state.pendingNotice;
  byId('open-notice-dialog').title = state.connected ? '' : '연결이 복구된 뒤 작성할 수 있습니다.';
  const status = byId('notice-send-status');
  status.hidden = !state.noticeMessage && !state.pendingNotice;
  status.dataset.error = String(state.noticeError);
  status.textContent = state.pendingNotice ? '고객 화면에 안내를 전달하고 있습니다.' : state.noticeMessage;
  const notifications = byId('notification-list');
  const expanded = new Set([...notifications.querySelectorAll('details[open]')].map(item => item.dataset.noticeId));
  notifications.innerHTML = selected.notices?.length
    ? [...selected.notices].reverse().map(notice => `<details class="notification-item" data-notice-id="${escapeHtml(notice.id)}"${expanded.has(String(notice.id)) ? ' open' : ''}><summary>${referenceIcon('expand')}<span class="notification-summary"><time class="event-time">${escapeHtml(notice.time || '-')}</time><strong>${escapeHtml(notice.title || '고객 안내')}</strong><span class="notification-channel">${escapeHtml(notice.channel || '고객 팝업')} 발송</span></span></summary><div class="notification-detail"><p class="notification-copy">${escapeHtml(notice.body)}</p><small>대상 ${escapeHtml(selected.name)}${notice.author ? ` (작성 ${escapeHtml(notice.author)})` : ''}</small></div></details>`).join('')
    : '<div class="empty-state compact"><strong>고객 알림이 없습니다.</strong></div>';
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
  const row = event.target.closest('[data-delivery-row]');
  const independentAction = event.target.closest('button, a, input, select, textarea, [role="button"]');
  const selectedId = selection?.dataset.select || (!independentAction && row?.dataset.deliveryRow);
  if (selectedId) {
    state.selectedId = selectedId;
    render();
  }

});
byId('delivery-search').value = state.query;
byId('delivery-status').value = state.status;
byId('delivery-search').addEventListener('input', event => { state.query = event.target.value; render(); });
byId('delivery-vehicle').addEventListener('change', event => { state.vehicleId = event.target.value; render(); });
byId('delivery-status').addEventListener('change', event => { state.status = event.target.value; render(); });
byId('clear-filters').addEventListener('click', () => {
  state.query = '';
  state.status = 'all';
  state.vehicleId = 'all';
  byId('delivery-search').value = '';
  byId('delivery-status').value = 'all';
  byId('delivery-vehicle').value = 'all';
  render();
});
function showMonitorDelivery(id) {
  if (!(state.data?.fleetDeliveries || state.data?.deliveries || []).some(delivery => delivery.id === id)) return;
  state.selectedId = id;
  render();
  byId('eta-panel').focus({ preventScroll: true });
  byId('eta-panel').scrollIntoView({ block: 'nearest' });
}
document.querySelectorAll('[data-monitor-current]').forEach(button => button.addEventListener('click', () => {
  showMonitorDelivery(selectedVehicleRoute(selectedDelivery()).find(delivery => delivery.status === 'current')?.id);
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

const noticeDialog = byId('customer-notice-dialog');
const noticeBody = byId('customer-notice-body');
byId('open-notice-dialog').addEventListener('click', event => {
  const selected = selectedDelivery();
  if (!selected || state.pendingNotice) return;
  byId('customer-notice-target').textContent = `${selected.name} (${selected.vehicle?.plate || '차량 미확인'})`;
  noticeBody.value = '';
  noticeBody.setCustomValidity('');
  byId('customer-notice-count').textContent = '0 / 300';
  noticeDialog.showModal();
  queueMicrotask(() => noticeBody.focus());
});
noticeBody.addEventListener('input', () => { byId('customer-notice-count').textContent = `${noticeBody.value.length} / 300`; });
byId('send-customer-notice').addEventListener('click', () => {
  const selected = selectedDelivery();
  const body = noticeBody.value.trim();
  if (!selected || !state.connected || state.pendingNotice) {
    state.noticeMessage = '연결이 복구된 뒤 다시 보내 주세요.'; state.noticeError = true; render(); return;
  }
  if (!body || body.length > 300) {
    noticeBody.setCustomValidity(body ? '안내 문구는 300자 이내로 작성해 주세요.' : '안내 문구를 입력해 주세요.');
    noticeBody.reportValidity();
    return;
  }
  noticeBody.setCustomValidity('');
  state.pendingNotice = { stopId: selected.id, body, seenIds: new Set((selected.notices || []).map(item => item.id)) };
  state.noticeMessage = ''; state.noticeError = false;
  noticeDialog.close();
  simulation.send('send_customer_notice', { stopId: selected.id, body });
  render();
});
