import { adaptSimulation, calculatedEtaText, publishedEtaText } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { deliveryLinks } from './delivery-review.mjs';
import { mountOrderPlanning } from './order-planning.mjs';
import { mountRouteEditor } from './route-editor.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { filterFleetDeliveries, normalizeVehicleFilter, operatorRoute, resolveDeliverySelection } from './operations-model.mjs';
import { paginate, PAGE_SIZE } from './pagination-model.mjs';
import { mountVehicleControl } from './vehicle-control.mjs';
import { vehicleOperations, resolveControlVehicle, resolveControlDelivery } from './vehicle-operations-model.mjs';
import { mountResourceManagement } from './resource-management.mjs';

const pages = {
  orders: { title: '배차 관리', description: '차량별 배정과 전체 주문 위치' },
  deliveries: { title: '자원 관리', description: '배송원, 차량과 배송지 정보' },
  control: { title: '배송 관제', description: '차량별 남은 업무와 현재 운행, 배송지별 처리 이력' },
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
  deliveryPage: 1,
  controlVehicleId: null,
  noticeTargetId: null,
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
const vehicleControl = mountVehicleControl({ element: byId('vehicle-control'),
  onSelectVehicle: id => {
    const row = vehicleOperations(state.data).find(item => item.vehicle.id === id);
    state.controlVehicleId = id;
    state.selectedId = row?.current?.id || row?.deliveries[0]?.id || null;
    render();
  }, onSelectDelivery: selectDelivery, onOpenNotice: openNotice,
  onOpenManagement: id => { selectDelivery(id); activateControlTab('management'); byId('tab-management').focus({ preventScroll: true }); },
  onOpenRoute: () => routeEditor.beginEdit(),
});
const routeEditor = mountRouteEditor({ element: byId('route-editor'), onSend: (type, extra) => simulation.send(type, extra), onSelect: selectDelivery,
  onCancel: () => { vehicleControl.showRecords(); document.querySelector('[data-control-route]').focus(); },
});
const orderPlanning = mountOrderPlanning({ element: byId('order-planning'), onSelect: selectDelivery });
const resourceManagement = mountResourceManagement({ element: byId('resource-management'), destinationElement: byId('resource-destinations'), onSelectDelivery: selectDelivery,
  onSelectVehicle: id => { state.vehicleId = id; state.deliveryPage = 1; render(); },
});
function selectDelivery(id) {
  state.selectedId = id;
  const selected = (state.data?.fleetDeliveries || state.data?.deliveries || []).find(item => item.id === id);
  if (selected) state.controlVehicleId = selected.vehicleId;
  render();
}
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
  let selected = selectedDelivery();
  const controlRow = state.page === 'control' ? resolveControlVehicle(vehicleOperations(state.data), state.controlVehicleId, selected?.id) : null;
  if (state.page === 'control') {
    state.controlVehicleId = controlRow?.vehicle.id || null;
    selected = resolveControlDelivery(controlRow, state.selectedId);
    state.selectedId = selected?.id || null;
  }
  // Reveal the replacement when the selected delivery disappears on a live update.
  if (selected && state.selectedId && selected.id !== state.selectedId) {
    const index = visibleDeliveries().findIndex(delivery => delivery.id === selected.id);
    state.deliveryPage = index < 0 ? 1 : Math.floor(index / PAGE_SIZE) + 1;
  }
  if (selected) state.selectedId = selected.id;
  renderPage();
  renderSummary();
  renderReview(selected);
  if (state.page === 'deliveries') { resourceManagement.update(state.data, state.selectedId); renderDeliveries(visibleDeliveries(), selected); }
  if (state.page === 'orders') orderPlanning.update(state.data, state.selectedId);
  if (state.page === 'control') {
    const row = controlRow;
    vehicleControl.update({ ...state.data, connected: state.connected }, state.controlVehicleId, selected?.id);
    routeEditor.update({ ...state.data, deliveries: row?.deliveries || [], vehicle: row?.vehicle || { live: false }, customerStopId: row?.vehicle.live ? state.data.customerStopId : null }, selected?.id, state.connected);
    const noticeStatus = byId('notice-send-status');
    noticeStatus.hidden = state.noticeTargetId !== selected?.id || (!state.noticeMessage && !state.pendingNotice);
    noticeStatus.dataset.error = String(state.noticeError);
    noticeStatus.textContent = state.pendingNotice ? '고객 화면에 안내를 전달하고 있습니다.' : state.noticeMessage;
    renderTabs();
  }
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
  } else if (!selected && state.page === 'control' && url.searchParams.has('id')) {
    url.searchParams.delete('id');
    history.replaceState(null, '', url);
  }
}

function renderDeliveries(visible, selected) {
  const total = (state.data.fleetDeliveries || state.data.deliveries).length;
  const paged = paginate(visible, state.deliveryPage);
  state.deliveryPage = paged.page;
  const vehicleSelect = byId('delivery-vehicle');
  const options = `<option value="all">전체 차량</option>${(state.data.fleetVehicles || []).map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate)} ${escapeHtml(vehicle.driver)}</option>`).join('')}`;
  if (vehicleSelect.innerHTML !== options) vehicleSelect.innerHTML = options;
  vehicleSelect.value = state.vehicleId;
  byId('delivery-count').textContent = `${visible.length} / ${total}건`;
  byId('delivery-empty').hidden = visible.length > 0;
  byId('delivery-range').textContent = visible.length ? `${paged.start}–${paged.end} / ${paged.total}건` : '0건';
  byId('delivery-page').textContent = `${paged.page} / ${paged.pageCount}`;
  byId('delivery-previous').disabled = paged.page === 1;
  byId('delivery-next').disabled = paged.page === paged.pageCount;
  renderInteractiveContent(byId('delivery-rows'), paged.items.map(delivery => `
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
  const selectionNote = !selected || paged.items.some(item => item.id === selected.id) ? ''
    : visible.some(item => item.id === selected.id) ? '선택한 배송은 다른 페이지에 있습니다.'
      : '선택한 배송은 현재 조회 조건에 포함되지 않습니다.';
  renderInteractiveContent(byId('delivery-selection'), selected ? `
    <div class="panel-heading"><h2>선택 배송</h2>${badge(statusLabels[selected.status] || '미확인', selected.statusTone)}</div>
    <div class="selection-body">${selectionNote ? `<p class="selection-filter-note">${selectionNote}</p>` : ''}<p class="eyebrow">${selected.sequence}번째 배송</p><h3>${escapeHtml(selected.name)}</h3><p class="muted">${escapeHtml(selected.address)}</p><strong class="selection-eta">${escapeHtml(selected.preciseTimeText || calculatedEtaText(selected))}</strong><p class="muted">고객 안내 ${escapeHtml(selected.customerWindowText || publishedEtaText(selected))}</p><dl class="key-values selection-key-values">${keyValue('차량', selected.vehicle?.plate)}${keyValue('배송원', selected.vehicle?.driver)}${keyValue('권역', selected.vehicle?.region)}${keyValue('박스', selected.boxes === null ? '미확인' : `${selected.boxes}박스`)}</dl><section class="delivery-tip"><p class="eyebrow">배송팁</p>${selected.tip ? `<p>${escapeHtml(selected.tip.body)}</p><small>${escapeHtml(selected.tip.author)} (${escapeHtml(selected.tip.updatedAt)})</small>` : '<p class="muted">배송원이 작성한 배송팁이 없습니다.</p>'}</section><div class="selection-actions"><a class="button primary" href="#/control">배송 관제</a><a class="button" href="#/control/manage">배송 관리</a></div></div>`
    : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>배송 데이터를 확인해 주세요.</p></div>');
}

function renderTabs() {
  document.querySelectorAll('[data-control-tab]').forEach(button => {
    const selected = button.dataset.controlTab === state.controlTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(button.getAttribute('aria-controls')).hidden = !selected;
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

  const selection = event.target.closest('[data-select]');
  const row = event.target.closest('[data-delivery-row]');
  const independentAction = event.target.closest('button, a, input, select, textarea, [role="button"]');
  const selectedId = selection?.dataset.select || (!independentAction && row?.dataset.deliveryRow);
  if (selectedId) {
    selectDelivery(selectedId);
  }

});
byId('delivery-search').value = state.query;
byId('delivery-status').value = state.status;
byId('delivery-search').addEventListener('input', event => { state.query = event.target.value; state.deliveryPage = 1; render(); });
byId('delivery-vehicle').addEventListener('change', event => { state.vehicleId = event.target.value; state.deliveryPage = 1; render(); });
byId('delivery-status').addEventListener('change', event => { state.status = event.target.value; state.deliveryPage = 1; render(); });
byId('clear-filters').addEventListener('click', () => {
  state.query = '';
  state.status = 'all';
  state.vehicleId = 'all';
  state.deliveryPage = 1;
  byId('delivery-search').value = '';
  byId('delivery-status').value = 'all';
  byId('delivery-vehicle').value = 'all';
  render();
});
byId('delivery-previous').addEventListener('click', () => { state.deliveryPage -= 1; render(); });
byId('delivery-next').addEventListener('click', () => { state.deliveryPage += 1; render(); });
byId('retry-connection').addEventListener('click', () => location.reload());
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
normalizeRoute();

function normalizeRoute() {
  const hash = state.page === 'control' && state.controlTab === 'management' ? '#/control/manage' : `#/${state.page}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function activateControlTab(tab) {
  state.controlTab = tab;
  const hash = tab === 'management' ? '#/control/manage' : '#/control';
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderTabs();
}

const controlTabs = [...document.querySelectorAll('[data-control-tab]')];
controlTabs.forEach((button, index) => {
  const activate = target => activateControlTab(target.dataset.controlTab);
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
function openNotice(id) {
  const selected = (state.data?.fleetDeliveries || []).find(item => item.id === id);
  if (!selected || state.pendingNotice || !state.connected) return;
  state.noticeTargetId = id;
  byId('customer-notice-target').textContent = `${selected.name} (${selected.vehicle?.plate || '차량 미확인'})`;
  noticeBody.value = '';
  noticeBody.setCustomValidity('');
  byId('customer-notice-count').textContent = '0 / 300';
  noticeDialog.showModal();
  queueMicrotask(() => noticeBody.focus());
}
noticeBody.addEventListener('input', () => { byId('customer-notice-count').textContent = `${noticeBody.value.length} / 300`; });
byId('send-customer-notice').addEventListener('click', () => {
  const selected = (state.data?.fleetDeliveries || []).find(item => item.id === state.noticeTargetId);
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
