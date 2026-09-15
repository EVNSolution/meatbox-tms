import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { deliveryLinks } from './delivery-review.mjs';
import { mountDatedDispatch } from './dated-dispatch.mjs';
import { mountRouteEditor } from './route-editor.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { operatorRoute, resolveDeliverySelection } from './operations-model.mjs';
import { mountVehicleControl } from './vehicle-control.mjs';
import { vehicleOperations, resolveControlVehicle, resolveControlDelivery } from './vehicle-operations-model.mjs';
import { mountResourceManagement } from './resource-management.mjs';
import { mountDestinationDirectory } from './destination-directory.mjs';
import { sourceVehicleContext } from './source-context.mjs';

const pages = {
  orders: { title: '배차 관리', description: '주문 확인, 배송원 선택과 배차 전송' },
  deliveries: { title: '자원 관리', description: '배송원, 차량과 배송지 정보' },
  control: { title: '배송 관제', description: '차량별 남은 업무와 현재 운행, 배송지별 처리 이력' },
};
const state = {
  ...operatorRoute(location.hash),
  data: null,
  selectedId: new URLSearchParams(location.search).get('id'),
  controlVehicleId: null,
  noticeTargetId: null,
  connected: false,
  pendingNotice: null,
  noticeMessage: '',
  noticeError: false,
};
const byId = id => document.getElementById(id);
document.querySelectorAll('[data-field-icon]').forEach(element => { element.innerHTML = referenceIcon(element.dataset.fieldIcon); });
const scenarioTools = mountDemoShell({ viewer: 'operator', onSelect: selectDelivery, onSend: (type, extra) => simulation.send(type, extra) });
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
const orderPlanning = mountDatedDispatch({ element: byId('order-planning'), onSelect: selectDelivery,
  onDateChange: date => simulation.selectDate(date),
  onCommand: async (type, extra) => {
    const result = await simulation.send(type, extra);
    if (!result) throw new Error('배차 요청을 처리하지 못했습니다. 최신 상태를 확인해 주세요.');
    return result;
  },
  onAssign: async extra => {
    const result = await simulation.send('reassign', extra);
    if (!result) throw new Error('배정을 변경하지 못했습니다. 현재 주문 상태를 확인해 주세요.');
    return { ...result, shared: true };
  }, onContextChange: () => { if (state.data) { renderSummary(); syncDispatchContext(); } } });
const destinationDirectory = mountDestinationDirectory({ element: byId('resource-destinations') });
const resourceManagement = mountResourceManagement({ element: byId('resource-management'), destinationElement: byId('resource-destinations'),
  onSelectDelivery: id => { selectDelivery(id); location.hash = '#/control/manage'; },
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
    if (next.sourceData?.date !== state.data?.sourceData?.date) {
      state.selectedId = next.fleetDeliveries.find(stop => stop.id === state.selectedId)?.id ?? next.customerStopId;
      state.controlVehicleId = null;
    }
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

function selectedDelivery() {
  return resolveDeliverySelection(state.data, state.selectedId);
}

function render() {
  if (!state.data) return;
  let selected = selectedDelivery();
  const controlRow = state.page === 'control' ? resolveControlVehicle(vehicleOperations(state.data), state.controlVehicleId, selected?.id) : null;
  if (state.page === 'control') {
    state.controlVehicleId = controlRow?.vehicle.id || null;
    selected = resolveControlDelivery(controlRow, state.selectedId);
    state.selectedId = selected?.id || null;
  }
  if (selected) state.selectedId = selected.id;
  state.data = sourceVehicleContext(state.data, state.selectedId);
  renderPage();
  renderSummary();
  renderReview(selected);
  if (state.page === 'deliveries') {
    resourceManagement.update(state.data, state.selectedId);
    destinationDirectory.update(state.data.sourceData?.date);
  }
  if (state.page === 'orders') orderPlanning.update(state.data, state.selectedId);
  if (state.page === 'control') {
    const row = controlRow;
    vehicleControl.update({ ...state.data, connected: state.connected }, state.controlVehicleId, selected?.id);
    routeEditor.update({ ...state.data, deliveries: row?.deliveries || [], vehicle: row?.vehicle || { live: false }, customerStopId: row?.vehicle.live ? state.data.customerStopId : null }, selected?.id, state.connected && !state.data.dispatch?.readOnly);
    const noticeStatus = byId('notice-send-status');
    noticeStatus.hidden = state.noticeTargetId !== selected?.id || (!state.noticeMessage && !state.pendingNotice);
    noticeStatus.dataset.error = String(state.noticeError);
    noticeStatus.textContent = state.pendingNotice ? '고객 화면에 안내를 전달하고 있습니다.' : state.noticeMessage;
    renderTabs();
  }
  scenarioTools.update(state.data, state.connected);
  syncDispatchContext();
}

function syncDispatchContext() {
  const sourcePage = state.page === 'orders' && orderPlanning.usesSource();
  byId('scenario-tools').hidden = sourcePage;
  if (sourcePage) byId('page-description').textContent = '주문 확인 → 배송원 선택 → 배차 계산 → 전체 배차 전송';
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
  } catch {}
  byId('page-description').textContent = page.description;
  if (state.data?.sourceData) byId('page-description').textContent = `${state.data.sourceData.date.replaceAll('-', '.')} 배송 운영`;
}

function renderSummary() {
  byId('summary-counts').hidden = state.page === 'deliveries';
  if (state.page === 'deliveries') return;
  if (state.page === 'orders' && orderPlanning.usesSource()) {
    const summary = orderPlanning.summary();
    byId('summary-counts').innerHTML = summary ? `<div><span>주문</span><strong>${summary.orders.toLocaleString('ko-KR')}</strong></div><div><span>박스</span><strong>${summary.boxes.toLocaleString('ko-KR')}</strong></div><div><span>후보 차량</span><strong>${summary.groups.toLocaleString('ko-KR')}</strong></div>` : '';
    return;
  }
  const deliveries = state.data.fleetDeliveries || state.data.deliveries;
  byId('summary-counts').innerHTML = `
    <div><span>차량</span><strong>${state.data.dispatch ? new Set(deliveries.map(item => item.vehicleId)).size : state.data.fleetVehicles?.length || (state.data.vehicle ? 1 : 0)}</strong></div>
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
  if (!selected || state.pendingNotice || !state.connected || state.data.dispatch?.readOnly) return;
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
  if (!selected || !state.connected || state.pendingNotice || state.data.dispatch?.readOnly) {
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
