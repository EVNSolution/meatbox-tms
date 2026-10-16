import { adaptOperations } from './operations-adapter.mjs';
import { connectOperations } from './operations-client.mjs';
import { mountDatedDispatch } from './dated-dispatch.mjs';
import { mountRouteEditor } from './route-editor.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { accountIcon, logoutIcon, settingsIcon } from './account-icons.mjs';
import { operatorRoute, routeHash, subtabs, controlDataPresentation, resolveDeliverySelection } from './operations-model.mjs';
import { mountVehicleControl } from './vehicle-control.mjs';
import { vehicleOperations, resolveControlVehicle, resolveControlDelivery } from './vehicle-operations-model.mjs';
import { mountResourceManagement } from './resource-management.mjs';
import { createDriverAssignmentClient } from './driver-assignment-client.ts';
import { dashboardMarkup, mountDashboard } from './operations-dashboard.ts';
import { createDriverProfileClient } from './driver-profile-client.ts';
import { masterMarkup, mountDriverMaster } from './driver-master.ts';
import { sourceVehicleContext } from './source-context.mjs';
import { mountDatePicker } from './date-picker.mjs';
import { seoulToday, validOperatingDate } from './operating-date.mjs';
import { dateNavActions, dateSummaryToolbar, mountDateSummaryToolbar } from './date-summary-toolbar.mjs';
import { mountStatusNotification } from '../src/shared/ui/status-notification.mjs';
import { driverNoticeText, readDriverNotice } from './driver-notice.ts';

const pages = {
  orders: { title: '배차 관리' },
  deliveries: { title: '자원 관리' },
  control: { title: '배송 관제' },
  dashboard: { title: '운영 현황' },
};
let pointerRouteTarget = null;
let resourcesEmpty = false;
const state = {
  ...operatorRoute(location.hash),
  data: null,
  dateContext: null,
  selectedId: new URLSearchParams(location.search).get('id'),
  controlVehicleId: null,
  connected: false,
  connectionMessage: '배송 정보를 불러오고 있습니다.',
};
const byId = id => document.getElementById(id);
function mountOperationalShell() {
  document.body.dataset.viewer = 'operator';
  byId('app-header').innerHTML = '<a class="brand" href="/combined/"><img src="./assets/meatbox-logo.svg" width="126" height="30" alt="미트박스"><span>TMS</span></a>';
  byId('app-navigation').innerHTML = '<nav class="app-nav-links" aria-label="운영 업무"><a href="#/orders" data-page-link="orders">배차 관리</a><a href="#/control" data-page-link="control">배송 관제</a><a href="#/deliveries" data-page-link="deliveries">자원 관리</a><a href="#/dashboard" data-page-link="dashboard">운영 현황</a><div class="app-nav-account" role="group" aria-label="계정">'
    + `<button type="button" class="app-icon-button" aria-disabled="true" aria-label="설정" title="설정 (준비 중)">${settingsIcon}</button>`
    + `<button type="button" class="app-icon-button" aria-disabled="true" aria-label="내 계정" title="내 계정 (준비 중)">${accountIcon}</button>`
    + `<form class="app-logout" method="post" action="/logout"><button type="submit" class="app-icon-button" aria-label="로그아웃" title="로그아웃">${logoutIcon}</button></form>`
    + '</div></nav>';
}
mountOperationalShell();
const statusNotification = mountStatusNotification({ element: byId('status-notification') });
const progressNotification = mountStatusNotification({ element: byId('progress-notification'), duration: 0 });
const reloadAction = { label: '다시 연결', run: () => location.reload() };
document.querySelectorAll('[data-field-icon]').forEach(element => { element.innerHTML = referenceIcon(element.dataset.fieldIcon); });
byId('control-date-toolbar').innerHTML = dateSummaryToolbar({ label: '관제 조회 날짜', actionsClass: 'date-nav', summaryLabel: '선택 관제일 요약', actions: dateNavActions('조회 날짜', 'id="control-date-picker"'), context: '<span id="control-readonly" class="control-readonly" hidden>이력 조회 (읽기 전용)</span>' });
const controlSummaryToolbar = mountDateSummaryToolbar(byId('control-date-toolbar'));
const controlDatePicker = mountDatePicker({ element: byId('control-date-picker'), label: '관제 조회 날짜', onChange: date => operations.selectDate(date) });
const controlDateButton = name => byId('control-date-toolbar').querySelector(`[data-date-${name}]`);
const stepControlDate = offset => {
  const dates = state.dateContext?.dates || [];
  const index = dates.findIndex(item => item.date === state.dateContext?.date);
  if (index >= 0 && dates[index + offset]) operations.selectDate(dates[index + offset].date);
};
controlDateButton('today').addEventListener('click', () => operations.selectDate(seoulToday()));
controlDateButton('prev').addEventListener('click', () => stepControlDate(-1));
controlDateButton('next').addEventListener('click', () => stepControlDate(1));
const vehicleControl = mountVehicleControl({ element: byId('vehicle-control'),
  onSelectVehicle: id => {
    const row = vehicleOperations(state.data).find(item => item.vehicle.id === id);
    state.controlVehicleId = id;
    state.selectedId = row?.current?.id || row?.deliveries[0]?.id || null;
    render();
  }, onSelectDelivery: selectDelivery,
  onOpenManagement: id => { selectDelivery(id); activateControlTab('management'); byId('tab-management').focus({ preventScroll: true }); },
  onOpenRoute: () => routeEditor.beginEdit(),
  onOpenTemperature: id => {
    const row = vehicleOperations(state.data).find(item => item.vehicle.id === id);
    state.controlVehicleId = id;
    state.selectedId = row?.current?.id || row?.deliveries[0]?.id || null;
    activateControlTab('temperature');
  },
});
const routeEditor = mountRouteEditor({ element: byId('route-editor'), onSend: (type, extra) => sendCommand(type, extra), onSelect: selectDelivery,
  onCancel: () => { vehicleControl.showRecords(); document.querySelector('[data-control-route]').focus(); },
});
const orderPlanning = mountDatedDispatch({ element: byId('order-planning'), onSelect: selectDelivery,
  onDateChange: date => operations.selectDate(date),
  onCommand: async (type, extra) => {
    const result = await sendCommand(type, extra);
    if (!result) throw new Error('배차 요청을 처리하지 못했습니다. 최신 상태를 확인해 주세요.');
    return result;
  },
  onAssign: async extra => {
    const result = await sendCommand('reassign', extra);
    if (!result) throw new Error('배정을 변경하지 못했습니다. 현재 주문 상태를 확인해 주세요.');
    return { ...result, shared: true };
  }, onContextChange: () => { if (state.data) renderSummary(); renderStatusNotification(); },
  notify: notice => { state.dispatchNotice = notice.message ? notice : null; renderProgress(); } });
byId('operations-dashboard').innerHTML = dashboardMarkup();
const operationsDashboard = mountDashboard({ element: byId('operations-dashboard') });
const driverAssignments = createDriverAssignmentClient();
byId('driver-master').innerHTML = masterMarkup();
mountDriverMaster({ element: byId('driver-master'), client: createDriverProfileClient(), refreshAssignments: () => driverAssignments.load(), assignedVehicles: username => (driverAssignments.snapshot?.assignments ?? []).filter(item => item.driver === username).map(item => item.vehicleId) });
mountResourceManagement({ element: byId('resource-management'), assignmentClient: driverAssignments, onEmptyChange: empty => { resourcesEmpty = empty; renderStatusNotification(); } });
// A command that moved a route answers with what the server told the drivers; show it for a moment on every screen.
let noticeSeq = 0;
async function sendCommand(type, extra) {
  const result = await operations.send(type, extra);
  const message = driverNoticeText(readDriverNotice(result?.driverNotice));
  if (message) {
    const id = ++noticeSeq;
    state.driverNotice = { id, message };
    renderStatusNotification();
    setTimeout(() => { if (state.driverNotice?.id === id) { state.driverNotice = null; renderStatusNotification(); } }, 5500);
  }
  return result;
}
function selectDelivery(id) {
  state.selectedId = id;
  const selected = (state.data?.fleetDeliveries || state.data?.deliveries || []).find(item => item.id === id);
  if (selected) state.controlVehicleId = selected.vehicleId;
  render();
}
const operations = connectOperations({
  onDateContext(context) {
    if ((state.dateContext && context.date !== state.dateContext.date) || context.empty || context.invalid) {
      state.data = null; state.selectedId = null; state.controlVehicleId = null;
    }
    state.dateContext = context;
    render();
  },
  onState(raw) {
    const next = adaptOperations(raw);
    if (next.sourceData?.date !== state.data?.sourceData?.date) {
      state.selectedId = next.fleetDeliveries.find(stop => stop.id === state.selectedId)?.id ?? next.customerStopId;
      state.controlVehicleId = null;
    }
    state.data = next;
    state.connected = true;
    render();
  },
  onStatus(connected, message) {
    state.connected = connected;
    state.connectionMessage = message;
    state.errorNotice = '';
    byId('live-pages').hidden = false;
  if (state.page === 'dashboard') operationsDashboard.show();
    render();
  },
  onError: message => {
    if (!routeEditor.showError(message)) { state.errorNotice = message; renderProgress(); }
  },
});

function selectedDelivery() {
  return resolveDeliverySelection(state.data, state.selectedId);
}

function render() {
  renderPage();
  renderControlDate();
  renderStatusNotification();
  renderProgress();
  byId('vehicle-control').hidden = false;
  byId('live-pages').hidden = false;
  if (state.page === 'orders') orderPlanning.update(state.data, state.selectedId, state.dateContext?.date);
  if (!state.data) {
    const presentation = controlDataPresentation(state.dateContext, state.connectionMessage);
    controlSummaryToolbar.update(['차량', '배송', '완료'].map(label => [label, presentation.empty ? 0 : '미확인']));
    vehicleControl.clear(presentation);
    routeEditor.clear();
    if (state.page === 'control') {
      if (!state.selectedId) renderReview(null);
      renderTabs();
    }
    return;
  }
  let selected = selectedDelivery();
  const controlRow = state.page === 'control' ? resolveControlVehicle(vehicleOperations(state.data), state.controlVehicleId, selected?.id) : null;
  if (state.page === 'control') {
    state.controlVehicleId = controlRow?.vehicle.id || null;
    selected = resolveControlDelivery(controlRow, state.selectedId);
    state.selectedId = selected?.id || null;
  }
  if (selected) state.selectedId = selected.id;
  state.data = sourceVehicleContext(state.data, state.selectedId);
  renderSummary();
  renderReview(selected);
  if (state.page === 'control') {
    const row = controlRow;
    vehicleControl.update({ ...state.data, connected: state.connected }, state.controlVehicleId, selected?.id);
    routeEditor.update({ ...state.data, deliveries: row?.deliveries || [], vehicle: row?.vehicle || { live: false }, customerStopId: row?.vehicle.live ? state.data.customerStopId : null }, selected?.id, state.connected && !state.data.dispatch?.readOnly);
    renderTabs();
  }
}

function renderPage() {
  const page = pages[state.page];
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== state.page; });
  document.querySelectorAll('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('page-heading').textContent = page.title;
  const tabs = subtabs[state.page] || [];
  const nav = byId('subtabs');
  nav.hidden = !tabs.length;
  const navKey = `${state.page}:${state.subtab}`;
  if (nav.dataset.key !== navKey) {
    nav.dataset.key = navKey;
    nav.innerHTML = tabs.map(([id, label]) => `<a href="${routeHash(state.page, id)}"${id === state.subtab ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  }
  const pageRoot = document.querySelector(`[data-page="${state.page}"]`);
  if (pageRoot) pageRoot.dataset.subtab = state.subtab;
  if (state.page === 'orders' && state.subtab === 'list') { const list = document.querySelector('.order-source-list'); if (list) list.open = true; }
  try {
    sessionStorage.setItem('meatbox.operator.page', state.page);
  } catch {}
}

function renderControlDate() {
  const context = state.dateContext;
  const date = context?.date;
  const today = seoulToday();
  const dates = context?.dates || [];
  controlDatePicker.update({ value: validOperatingDate(date) ? date : '', dates: [...dates, { date: today }], disabled: !context });
  const index = dates.findIndex(item => item.date === date);
  controlDateButton('today').disabled = !context || date === today;
  controlDateButton('prev').disabled = !context || index <= 0;
  controlDateButton('next').disabled = !context || index < 0 || index >= dates.length - 1;
  byId('control-readonly').hidden = !(validOperatingDate(date) && date < today || state.data?.dispatch?.readOnly);
}

function renderProgress() {
  let notice = null;
  if (state.errorNotice) notice = { message: state.errorNotice, action: reloadAction, tone: 'error' };
  else if (!state.connected && state.page !== 'deliveries' && state.page !== 'dashboard') notice = { message: state.connectionMessage, action: reloadAction };
  else if (state.page === 'orders' && state.dispatchNotice) notice = { message: state.dispatchNotice.message, action: state.dispatchNotice.retry ? { label: '다시 불러오기', run: state.dispatchNotice.retry } : null, tone: state.dispatchNotice.failed ? 'error' : '' };
  else if (state.page === 'control' && !state.data) {
    const presentation = controlDataPresentation(state.dateContext, state.connectionMessage);
    if (!presentation.empty) notice = { message: presentation.message };
  }
  progressNotification.update({ context: 'progress', key: notice ? `${notice.message}|${notice.action?.label || ''}` : undefined, message: notice?.message || '', action: notice?.action || null, tone: notice?.tone || '' });
}

function renderStatusNotification() {
  if (state.driverNotice) {
    statusNotification.update({ context: `driver:${state.driverNotice.id}`, key: `driver:${state.driverNotice.id}`, message: state.driverNotice.message });
    return;
  }
  const date = state.dateContext?.date;
  const context = `${state.page}:${state.page === 'deliveries' ? '' : date || ''}`;
  let message = '';
  if (state.page === 'orders') {
    const dispatch = orderPlanning.status();
    if (dispatch.empty && dispatch.date === date) message = `${date}에 등록된 주문이 없습니다.`;
  } else if (state.page === 'deliveries' && resourcesEmpty) {
    message = '등록된 차량이 없습니다.';
  } else if (state.page === 'control' && !state.dateContext?.invalid) {
    if (state.dateContext?.empty) message = `${date}에 배송 자료가 없습니다.`;
    else if (state.data && !vehicleOperations(state.data).some(item => !state.data.dispatch || item.deliveries.length)) message = `${date}에 확정된 배차가 없습니다.`;
  }
  statusNotification.update({ context, key: message ? `${context}:empty` : undefined, message });
}

function renderSummary() {
  if (state.page !== 'control' || state.dateContext && (state.dateContext.empty || state.dateContext.invalid || state.dateContext.date !== state.data.sourceData?.date)) { controlSummaryToolbar.clear(); return; }
  const deliveries = state.data.fleetDeliveries || state.data.deliveries;
  controlSummaryToolbar.update([
    ['차량', state.data.dispatch ? new Set(deliveries.map(item => item.vehicleId)).size : state.data.fleetVehicles?.length || (state.data.vehicle ? 1 : 0)],
    ['배송', deliveries.length],
    ['완료', deliveries.filter(item => item.status === 'done').length],
  ]);
}

function renderReview(selected) {
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

byId('subtabs').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link && event.detail > 0) pointerRouteTarget = new URL(link.href).hash;
});
byId('app-navigation').addEventListener('click', event => {
  const link = event.target.closest('[data-page-link]');
  if (link && event.detail > 0) {
    const target = new URL(link.href).hash;
    if (target !== location.hash) pointerRouteTarget = target;
  }
});
window.addEventListener('hashchange', () => {
  Object.assign(state, operatorRoute(location.hash));
  normalizeRoute();
  render();
  const fromPointerMenu = pointerRouteTarget === location.hash;
  pointerRouteTarget = null;
  // Pointer users keep focus on the selected menu; keyboard users enter the new page.
  if (!fromPointerMenu) byId('page-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  statusNotification.destroy();
  progressNotification.destroy();
  operations.close();
  orderPlanning.destroy();
  operationsDashboard.destroy();
  vehicleControl.destroy();
  controlDatePicker.destroy();
});
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
normalizeRoute();

function normalizeRoute() {
  const hash = routeHash(state.page, state.subtab);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function activateControlTab(tab) {
  state.controlTab = tab;
  state.subtab = tab === 'management' ? 'records' : tab === 'temperature' ? 'temperature' : 'stops';
  const hash = routeHash('control', state.subtab);
  if (location.hash !== hash) history.pushState(null, '', hash);
  render();
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
