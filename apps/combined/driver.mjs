import { adaptSimulation } from './simulation-adapter.mjs';
import { sourceVehicleContext } from './source-context.mjs';
import { transportConditionText } from './source-viewer-plan.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import {
  completionProofCanSubmit,
  completionProofShouldClose,
  driverMapDelivery,
  driverTipDelivery,
  driverViewModel,
  reconcileDriverRoute,
} from './driver-view-model.mjs';
import { movePendingOrder } from './route-editor.mjs';
import { mountDriverMap } from './driver-map.mjs';
import { openDriverSettings } from './driver-settings.mjs';
import { driverHistoryForDate, exampleHistoryDates, sourceDriverHistoryForDate } from './driver-history.mjs';
import { renderDriverHistoryCalendar, shiftHistoryMonth } from './driver-history-calendar.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { renderCustomerRequests } from './customer-requests.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);
const exampleProofUrl = new URL('./assets/delivery-proof-example.jpg', import.meta.url).href;
const icons = {
  settings: '<path d="M9.91 5.16 L10.84 2.57 L13.16 2.57 L14.09 5.16 A7.15 7.15 0 0 1 15.36 5.69 L17.85 4.51 L19.49 6.15 L18.31 8.64 A7.15 7.15 0 0 1 18.84 9.91 L21.43 10.84 L21.43 13.16 L18.84 14.09 A7.15 7.15 0 0 1 18.31 15.36 L19.49 17.85 L17.85 19.49 L15.36 18.31 A7.15 7.15 0 0 1 14.09 18.84 L13.16 21.43 L10.84 21.43 L9.91 18.84 A7.15 7.15 0 0 1 8.64 18.31 L6.15 19.49 L4.51 17.85 L5.69 15.36 A7.15 7.15 0 0 1 5.16 14.09 L2.57 13.16 L2.57 10.84 L5.16 9.91 A7.15 7.15 0 0 1 5.69 8.64 L4.51 6.15 L6.15 4.51 L8.64 5.69 A7.15 7.15 0 0 1 9.91 5.16Z"/><circle cx="12" cy="12" r="3.2"/>',
  logout: '<path d="M9 4H4v16h5M15 8l4 4-4 4m-7-4h11"/>',
  package: '<path d="m12 3 9 5v9l-9 5-9-5V8Zm-9 5 9 5 9-5M12 13v9M7.5 5.5l9 5V15"/>',
  map: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
let latest, fullLatest, connected = false, selectedId = new URLSearchParams(location.search).get('id');
let tab = 'delivery', screen = 'main', group = null, routeCompleted = null, orderGroup = 'own', mapSelection = null;
let draft = null, base = null, editMapOpen = true, drag = null, pending = null, pendingTimer;
let sheet = null, returnFocus = null, proofUrl = null, detailTab = 'order';
let proofCheckedIds = new Set();
let historyDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
let historySourceDate = null, historyVehicleId = null, historySelectionKey = null;
const historyCache = new Map();
const tipDrafts = new Map();
const shell = mountDemoShell({ viewer: 'driver', onSelect: selectScenarioDelivery,
  onSend: (type, extra) => dispatchPending() || dispatchReadOnly() ? false : simulation.send(type, extra) });
shell.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    fullLatest = adaptSimulation(raw);
    latest = sourceVehicleContext(fullLatest, selectedId);
    if (latest.truck && Number.isFinite(raw.truck?.remainingM)) latest.truck.remainingM = raw.truck.remainingM;
    if (pending?.accept(latest)) {
      const done = pending.done;
      clearTimeout(pendingTimer); pending = null;
      done?.();
    }
    render();
  },
  onStatus(value, message) {
    connected = value;
    byId('driver-connection').hidden = value;
    byId('driver-connection').textContent = message;
    if (!value && pending) failCommand('연결이 끊겨 처리 여부를 확인할 수 없습니다. 다시 연결되면 상태를 확인해 주세요.');
    shell.update(latest, value);
    if (latest) render();
  },
  onError(message) { failCommand(message); shell.showError(message); },
});
const map = mountDriverMap(byId('dv-map'), id => { mapSelection = id; renderMapDetail(); });
const editMap = mountDriverMap(byId('dv-edit-map'), () => {});
const view = () => driverViewModel(latest, connected, selectedId);
const signature = () => JSON.stringify([latest.phase, view().deliveries.map(stop => [stop.id, stop.status])]);
const activeRoute = () => group === 'today';
const disabled = condition => condition ? 'disabled' : '';
const dispatchPending = () => Boolean(latest?.sourceData && latest.dispatch && latest.dispatch.phase !== 'published');
const dispatchReadOnly = () => Boolean(latest?.sourceData && latest.dispatch?.readOnly);
const eta = stop => stop?.completedAt || stop?.arrivedAt || stop?.preciseTimeText || stop?.officialEta?.time || '—';
const vehicleDisplay = vehicle => vehicle?.plate || '미확인';
const conditionText = stop => latest?.sourceData ? transportConditionText(stop) : [...new Set((stop.items || []).flatMap(item => ['냉장', '냉동'].filter(condition => String(item.name).includes(condition))))].join(' / ') || '운송 조건 미등록';
const summary = deliveries => `${deliveries.length}곳 <span>${deliveries.reduce((sum, stop) => sum + (stop.boxes || 0), 0)}박스</span>`;
const requestSignature = stop => JSON.stringify((stop?.customerRequests?.items || []).map(item => item.id));
const compactRequest = stop => {
  const html = renderCustomerRequests(stop, { compact: true, showSource: false });
  return html ? `<span class="dv-current-request">${html}</span>` : '';
};
function feedback(message) { byId('dv-feedback').textContent = message; byId('dv-feedback').hidden = !message; }
function failCommand(message) { clearTimeout(pendingTimer); pending = null; feedback(message); if (latest) render(); }
function sendCommand(type, payload, accept, done) {
  if (!connected || pending || dispatchPending() || dispatchReadOnly()) return;
  pending = { accept, done };
  feedback('저장 중입니다.');
  pendingTimer = setTimeout(() => failCommand('서버 응답을 확인하지 못했습니다. 상태를 확인한 뒤 다시 시도해 주세요.'), 5000);
  simulation.send(type, payload);
  render();
}
function patch(id, html) {
  const element = byId(id);
  if (element._html === html) return;
  const focused = element.contains(document.activeElement) ? document.activeElement : null;
  const key = focused?.dataset.focus;
  const scroll = element.scrollTop;
  element.innerHTML = html; element._html = html; element.scrollTop = scroll;
  if (key) [...element.querySelectorAll('[data-focus]')].find(item => item.dataset.focus === key)?.focus({ preventScroll: true });
}
function selectScenarioDelivery(id) {
  if (dispatchPending() || dispatchReadOnly()) return;
  selectedId = id;
  latest = sourceVehicleContext(fullLatest, selectedId);
  mapSelection = id;
  const url = new URL(location.href); url.searchParams.set('id', id); history.replaceState(null, '', url);
  shell.select(id);
  render();
}
function selectVehicle(id) {
  if (pending) return;
  selectedId = id; mapSelection = null; draft = null; screen = 'main'; group = null; routeCompleted = null;
  latest = sourceVehicleContext(fullLatest, selectedId);
  const url = new URL(location.href); url.searchParams.set('id', id); history.replaceState(null, '', url);
  shell.select(id); closeSheet(); feedback(''); render();
}
function render() {
  if (!latest) return;
  latest = sourceVehicleContext(fullLatest, selectedId);
  if (!selectedId) selectedId = latest.customerStopId || latest.deliveries[0]?.id;
  const model = view();
  const waitingForDispatch = dispatchPending();
  const resolvedId = model.selected?.id || selectedId;
  if (resolvedId && resolvedId !== selectedId) {
    selectedId = resolvedId;
    latest = sourceVehicleContext(fullLatest, selectedId);
    const url = new URL(location.href); url.searchParams.set('id', selectedId); history.replaceState(null, '', url);
  }
  if (latest.sourceData?.date !== historySourceDate) {
    historySourceDate = latest.sourceData?.date || null;
    if (historySourceDate) historyDate = historySourceDate;
    historyVehicleId = null;
  }
  const route = reconcileDriverRoute(routeCompleted, latest.phase === 'done' && model.vehicle?.live !== false, group);
  routeCompleted = route.completed; group = route.group;
  if (route.changed) { screen = 'main'; draft = null; drag = null; mapSelection = null; }
  const proofRequestChanged = sheet?.kind === 'proof' && sheet.requestSignature !== requestSignature(model.current);
  if (sheet?.kind === 'proof' && (completionProofShouldClose(latest, connected, sheet.stopId) || proofRequestChanged)) {
    closeSheet(true);
    feedback(proofRequestChanged ? '고객 요청이 변경되어 배송 완료 화면을 닫았습니다. 최신 요청을 확인해 주세요.' : connected ? '도착 상태가 변경되어 배송 완료 화면을 닫았습니다.' : '연결이 끊겨 배송 완료 화면을 닫았습니다. 다시 연결한 뒤 사진을 새로 촬영해 주세요.');
  }
  byId('driver-workspace').hidden = false;
  shell.update(latest, connected); shell.select(selectedId);
  byId('driver-clock').textContent = latest.simClock || '--:--';
  byId('driver-name').textContent = waitingForDispatch ? '배송원' : `${model.vehicle?.driver || '배송원 미확인'}${model.vehicle?.driver ? ' 배송원' : ''}`;
  const vehicleLabel = waitingForDispatch ? '확정 배차 없음' : vehicleDisplay(model.vehicle);
  byId('driver-vehicle').textContent = vehicleLabel;
  byId('driver-region').textContent = waitingForDispatch ? '배차 전송 대기' : model.vehicle?.region || '미등록';
  byId('driver-done').textContent = model.progress;
  byId('driver-left').textContent = `${model.remainingBoxes}박스`;
  byId('driver-finish').textContent = waitingForDispatch ? '배차 전송 대기' : latest.sourceData && model.finishEta === '—' ? '시간 정보 미제공' : model.finishEta;
  const sourceDateQuery = latest.sourceData?.date ? `&date=${encodeURIComponent(latest.sourceData.date)}` : '';
  byId('driver-manage-link').href = `/combined/?${selectedId ? `id=${encodeURIComponent(selectedId)}&` : ''}${sourceDateQuery.replace(/^&/, '')}#/control/manage`;
  const vehicles = waitingForDispatch ? [] : latest.fleetVehicles?.length ? latest.fleetVehicles : [model.vehicle].filter(Boolean);
  const select = byId('driver-vehicle-select');
  const options = vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate)} / ${escapeHtml(vehicle.driver)}</option>`).join('')
    || (waitingForDispatch ? '<option value="">확정 배차 없음</option>' : '');
  if (select._html !== options) { select.innerHTML = options; select._html = options; }
  select.value = waitingForDispatch ? '' : model.vehicle?.id || ''; select.disabled = Boolean(pending) || waitingForDispatch;
  byId('dv-route-label').textContent = vehicleLabel;
  byId('dv-route-status').textContent = model.status;
  const routeDate = byId('dv-route-choice').querySelector('summary strong');
  if (routeDate) routeDate.textContent = latest.sourceData?.date || '오늘';
  const routeChoice = byId('dv-select-today').querySelector('span');
  if (routeChoice) routeChoice.textContent = latest.sourceData ? `${latest.sourceData.date} 배송` : '오늘 배송';
  byId('dv-select-today').disabled = !activeRoute();
  document.querySelectorAll('[data-group]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.group === group)); button.disabled = Boolean(pending); });
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab)); button.tabIndex = button.dataset.tab === tab ? 0 : -1; button.disabled = Boolean(pending) || group === 'history' || waitingForDispatch;
  });
  byId('dv-settings').disabled = byId('dv-logout').disabled = Boolean(pending);
  if (draft && !pending && signature() !== base.signature) {
    draft = null; drag = null; screen = 'main'; feedback('배송 상태가 바뀌어 편집을 종료했습니다. 최신 순서에서 다시 편집해 주세요.');
  }
  byId('dv-route-selector').hidden = screen === 'edit';
  byId('dv-route-choice').hidden = group === 'history';
  byId('dv-tabs').hidden = group === 'history';
  byId('dv-delivery').hidden = screen !== 'main' || tab !== 'delivery' || group === 'history';
  byId('dv-map-panel').hidden = screen !== 'main' || tab !== 'map' || group === 'history';
  byId('dv-history').hidden = screen !== 'main' || group !== 'history';
  byId('dv-orders').hidden = screen !== 'orders';
  byId('dv-editor').hidden = screen !== 'edit';
  if (waitingForDispatch && group !== 'history') {
    screen = 'main'; tab = 'delivery'; draft = null; mapSelection = null;
    byId('dv-delivery').hidden = false;
    byId('dv-map-panel').hidden = true;
    byId('dv-orders').hidden = true;
    byId('dv-editor').hidden = true;
    patch('dv-delivery', '<div class="dv-empty"><strong>확정된 배차가 없습니다</strong><span class="dv-muted">배차 전송 후 배송 목록을 확인할 수 있습니다.</span></div>');
    map.update([], false, false, { sourceData: latest.sourceData, vehicle: null });
  }
  else if (screen === 'edit') renderEditor();
  else if (screen === 'orders') renderOrders();
  else if (group === 'history') renderHistory();
  else if (tab === 'delivery') renderDelivery();
  else {
    mapSelection = driverMapDelivery(model.deliveries, mapSelection)?.id || null;
    const mapVehicle = latest.sourceData && latest.truck?.locationSource === 'demo'
      ? { ...model.vehicle, location: { source: 'demo', coordinates: [latest.truck.lng, latest.truck.lat] } }
      : model.vehicle;
    map.update(activeRoute() ? model.deliveries : [], latest.truck?.dwelling, false, { sourceData: latest.sourceData, vehicle: mapVehicle });
    renderMapDetail();
  }
  if (sheet?.kind === 'detail') {
    const stop = model.deliveries.find(stop => stop.id === sheet.stopId);
    if (stop) {
      byId('dv-sheet-title').textContent = stop.name;
      byId('dv-sheet-subtitle').textContent = `${stop.sequence}번째 배송지`;
    }
    updateTip();
  }
  if (sheet?.kind === 'proof') {
    const confirm = byId('dv-proof-confirm');
    if (confirm) confirm.disabled = dispatchReadOnly() || !completionProofCanSubmit(latest, connected, sheet.stopId, proofUrl, [...proofCheckedIds]) || Boolean(pending);
    const time = byId('dv-proof-time');
    if (time) time.value = latest.simClock;
  }
  if (sheet?.kind === 'start') byId('dv-sheet-body').querySelector('[data-confirm-start]').disabled = Boolean(pending) || !connected || signature() !== sheet.startSignature;
  if (sheet) byId('dv-sheet-close').disabled = Boolean(pending);
}
function stopCard(stop, attributes = '') {
  return `<button class="dv-stop" data-status="${escapeHtml(stop.status)}" data-stop="${escapeHtml(stop.id)}" data-focus="stop-${escapeHtml(stop.id)}" ${attributes}><span class="dv-stop-number">${stop.status === 'done' ? referenceIcon('check') : stop.sequence}</span><span class="dv-stop-copy"><span class="dv-stop-name"><strong>${escapeHtml(stop.name)}</strong>${stop.status === 'current' ? '<span class="dv-chip">배송 중</span>' : ''}</span><span class="dv-stop-address">${escapeHtml(stop.address)}</span><span class="dv-stop-meta"><span>${escapeHtml(conditionText(stop))}</span><span>${stop.boxes ?? '—'}박스</span><span>${stop.status === 'done' ? `${escapeHtml(eta(stop))} 완료` : statusLabels[stop.status]}</span></span></span></button>`;
}
function executionButtons() {
  const model = view();
  if (dispatchReadOnly()) return '<p class="dv-muted">과거 배차는 조회만 할 수 있습니다.</p>';
  if (model.vehicle?.live === false) return '<p class="dv-muted">조회 전용 배차입니다.</p>';
  if (latest.phase === 'done') return '<p class="dv-muted">모든 배송을 완료했습니다.</p>';
  if (latest.phase !== 'delivering') return `<button class="dv-button dv-primary dv-start" aria-label="배송 시작" data-action="start" ${disabled(!connected || latest.phase !== 'preparing' || pending)}><span>배송 시작</span><small>픽업 완료</small></button>`;
  return `<div class="dv-inline"><button class="dv-button dv-soft" data-action="open-map">지도 열기</button><button class="dv-button dv-primary" data-action="complete" ${disabled(!model.canComplete || pending)}>배송 완료</button></div>${model.canComplete ? '' : '<p class="dv-action-hint">배송지에 도착하면 완료할 수 있습니다.</p>'}`;
}
function renderDelivery() {
  if (!activeRoute()) return;
  const model = view();
  const actualDeparture = latest.viewerPlan?.timing?.actualDepartureText
    || model.deliveries[0]?.timeline?.find(item => ['배송 중', '배송 출발'].includes(item.label))?.time;
  const departure = actualDeparture || latest.viewerPlan?.departureText || (latest.sourceData ? '시각 미제공' : '출발 전');
  const departureLabel = actualDeparture ? '배송 시작' : '계획 출발';
  const title = latest.sourceData ? `${latest.sourceData.date} 배차` : '금일 배차';
  const finish = latest.viewerPlan?.finishText || (latest.sourceData && model.finishEta === '—' ? '시간 정보 미제공' : model.finishEta);
  const finishLabel = latest.phase === 'done' ? '배송 완료' : '완료 예상';
  patch('dv-delivery', `<header class="dv-delivery-heading"><div><h2>${escapeHtml(title)}</h2><p>${summary(model.deliveries)}</p></div><div class="dv-heading-actions"><button class="dv-button dv-soft" data-action="orders">주문 목록</button><button class="dv-button dv-primary" data-action="edit" ${disabled(dispatchReadOnly() || model.vehicle?.live === false || !connected || pending || model.deliveries.filter(stop => stop.status === 'pending').length < 2)}>순서 편집</button></div></header><section class="dv-today-status" aria-label="배차 진행 및 완료 현황"><div><span>진행·대기</span><strong>${model.todayCounts.active}곳</strong></div><div><span>완료</span><strong>${model.todayCounts.done}곳</strong></div><div><span>보류</span><strong>${model.todayCounts.skipped}곳</strong></div></section><section class="dv-eta" aria-label="배송 예상 시간"><div><span>${departureLabel}</span><strong>${escapeHtml(departure)}</strong></div>${icon('arrow')}<div><span>${finishLabel}</span><strong>${escapeHtml(finish)}</strong></div></section><section class="dv-execution"><p class="dv-eyebrow">${latest.phase === 'done' ? '완료된 배차' : '지금 가는 배송지'}</p>${compactRequest(model.current)}<h3>${escapeHtml(model.destination)}</h3><p class="dv-muted">${escapeHtml(model.address)}</p>${executionButtons()}</section><ol class="dv-route">${model.deliveries.map(stop => `<li>${stopCard(stop)}</li>`).join('')}</ol>`);
}
function renderHistory() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const calendar = renderDriverHistoryCalendar(historyDate, latest.sourceData?.dates || exampleHistoryDates, today, Boolean(latest.sourceData));
  const heading = `<header class="dv-delivery-heading"><div><h2>근무 이력</h2><p>달력에서 날짜를 선택해 주세요.</p></div></header>`;
  const selectedHeading = `<h3 class="dv-history-selected">${escapeHtml(historyDate.replaceAll('-', '.'))} 이력</h3>`;
  if (latest.sourceData) {
    const model = view();
    const vehicle = dispatchPending()
      ? latest.fleetVehicles.find(item => item.id === historyVehicleId) || latest.vehicle
      : model.vehicle;
    const identity = { driver: vehicle?.driver, plate: vehicleDisplay(vehicle), originalGroupId: vehicle?.id };
    const cacheKey = `${historyDate}|${identity.driver}|${identity.originalGroupId || ''}`;
    historySelectionKey = cacheKey;
    const selector = dispatchPending() ? `<div class="dv-history-driver"><label for="dv-history-driver">이력 조회 배송원</label><select id="dv-history-driver" data-focus="history-driver">${latest.fleetVehicles.map(item => `<option value="${escapeHtml(item.id)}"${item.id === vehicle?.id ? ' selected' : ''}>${escapeHtml(item.driver)} / ${escapeHtml(vehicleDisplay(item))}</option>`).join('')}</select></div>` : '';
    const layout = heading + selector + calendar + selectedHeading;
    if (!identity.driver) { patch('dv-history', `${layout}<p class="dv-empty">이력을 조회할 배송원 정보가 없습니다.</p>`); return; }
    let cached = historyCache.get(cacheKey);
    if (!cached) {
      cached = { status: 'loading', records: [] };
      historyCache.set(cacheKey, cached);
      sourceDriverHistoryForDate(historyDate, identity).then(records => {
        cached.status = 'ready'; cached.records = records;
      }).catch(() => { cached.status = 'error'; }).finally(() => {
        if (group === 'history' && historySelectionKey === cacheKey) renderHistory();
      });
    }
    if (cached.status === 'loading') { patch('dv-history', `${layout}<div class="dv-empty" role="status">배차 내역을 불러오고 있습니다.</div>`); return; }
    if (cached.status === 'error') { patch('dv-history', `${layout}<div class="dv-empty" role="status">배차 내역을 불러오지 못했습니다.<button type="button" class="dv-button" data-action="retry-history">다시 불러오기</button></div>`); return; }
    const records = cached.records.map(item => `<article class="dv-history-card"><header><div><h3>${escapeHtml(item.label)}</h3></div></header><dl class="dv-key-values"><div><dt>배송 규모</dt><dd>${item.destinations}곳 / ${item.boxes}박스</dd></div></dl><p class="dv-muted">원본 배차 내역 · 실제 근무 시간 미제공</p></article>`).join('');
    patch('dv-history', layout + (records || '<div class="dv-empty">선택한 날짜에 이 배송원의 배차가 없습니다.</div>'));
    return;
  }
  const history = driverHistoryForDate(historyDate);
  const records = history.map(item => `<article class="dv-history-card"><header><div><span class="dv-demo-badge">예시</span><h3>${escapeHtml(item.label)}</h3></div><strong>${escapeHtml(item.vehicle)}</strong></header><dl class="dv-key-values"><div><dt>근무 시간</dt><dd>${item.startedAt}–${item.endedAt}</dd></div><div><dt>배송 규모</dt><dd>${item.destinations}곳 / ${item.boxes}박스</dd></div></dl></article>`).join('');
  patch('dv-history', heading + calendar + selectedHeading + (records || '<div class="dv-empty">선택한 날짜의 예시 기록이 없습니다.</div>'));
}
function renderMapDetail() {
  if (!latest) return;
  const model = view();
  const stop = driverMapDelivery(model.deliveries, mapSelection);
  mapSelection = stop?.id || null;
  if (!activeRoute() || !stop) { patch('dv-map-detail', '<p class="dv-empty">선택할 배송지가 없습니다.</p>'); return; }
  patch('dv-map-detail', `<p class="dv-eyebrow">${stop.status === 'current' ? '지금 가는 배송지' : `${stop.sequence}번째 배송지`}</p>${stopCard(stop)}<dl class="dv-stats"><div><dt>상품 종류</dt><dd>${stop.items?.length || '—'}</dd></div><div><dt>박스 수</dt><dd>${stop.boxes ?? '—'}</dd></div><div><dt>ETA</dt><dd>${escapeHtml(eta(stop))}</dd></div></dl>${stop.id === model.current?.id ? executionButtons() : `<button class="dv-button dv-soft" data-stop="${escapeHtml(stop.id)}">주문 정보</button>`}`);
}
function renderOrders() {
  const model = view();
  const title = latest.sourceData ? `${latest.sourceData.date} 배송` : '오늘 배송';
  patch('dv-orders', `<header class="dv-subheader"><button class="dv-text-button" data-action="back">뒤로</button><h2>주문 목록</h2><span></span></header><div class="dv-delivery-heading"><div><h2>${escapeHtml(title)}</h2><p>${summary(model.deliveries)}</p></div></div><div class="dv-segments dv-order-segments" role="group" aria-label="주문 구분"><button data-orders="own" aria-pressed="${orderGroup === 'own'}">내 배송</button><button data-orders="common" aria-pressed="${orderGroup === 'common'}">공용 배송</button></div>${orderGroup === 'common' ? '<div class="dv-empty">공용 배송에 등록된 주문이 없습니다.</div>' : `<ol class="dv-route">${model.deliveries.map(stop => `<li>${stopCard(stop)}<div class="dv-order-actions"><button class="dv-button" data-assignment="return" data-stop-id="${stop.id}" ${disabled(dispatchReadOnly() || ['done','skipped'].includes(stop.status))}>반납</button><button class="dv-button dv-soft" data-assignment="transfer" data-stop-id="${stop.id}" ${disabled(dispatchReadOnly() || ['done','skipped'].includes(stop.status))}>전달</button></div></li>`).join('')}</ol>`}`);
}
function beginEdit() {
  if (dispatchPending() || dispatchReadOnly()) return;
  const model = view();
  if (!connected || pending || model.vehicle?.live === false || model.deliveries.filter(stop => stop.status === 'pending').length < 2) return;
  draft = model.deliveries.map(stop => stop.id);
  base = { order: [...draft], statuses: model.deliveries.map(stop => stop.status), phase: latest.phase, signature: signature() };
  screen = 'edit'; feedback(''); render();
}
function renderEditor() {
  if (!draft) return;
  const stops = draft.map(id => view().deliveries.find(stop => stop.id === id));
  const eligible = stops.filter(stop => stop.status === 'pending');
  byId('dv-save-order').disabled = Boolean(pending) || !connected || dispatchReadOnly() || draft.every((id, index) => id === base.order[index]);
  byId('dv-edit-map').hidden = !editMapOpen;
  byId('dv-edit-map-toggle').textContent = editMapOpen ? '지도 접기' : '지도 보기';
  byId('dv-edit-map-toggle').setAttribute('aria-expanded', String(editMapOpen));
  const mapVehicle = latest.sourceData && latest.truck?.locationSource === 'demo'
    ? { ...view().vehicle, location: { source: 'demo', coordinates: [latest.truck.lng, latest.truck.lat] } }
    : view().vehicle;
  if (editMapOpen) editMap.update(stops.map((stop, index) => ({ ...stop, sequence: index + 1 })), latest.truck?.dwelling, true, { sourceData: latest.sourceData, vehicle: mapVehicle });
  if (drag) return;
  patch('dv-edit-list', stops.map((stop, index) => `<li class="dv-edit-row" data-route-id="${stop.id}" data-status="${stop.status}"><button class="dv-icon dv-handle" data-handle="${stop.id}" data-focus="handle-${stop.id}" aria-label="${escapeHtml(stop.name)} 순서 이동" ${disabled(stop.status !== 'pending' || pending || !connected)}>${referenceIcon('handle')}</button><span class="dv-stop-number">${index + 1}</span><span class="dv-stop-copy"><strong>${escapeHtml(stop.name)}</strong><span class="dv-stop-address">${escapeHtml(stop.address)}</span><span class="dv-stop-meta">${stop.boxes}박스</span></span>${stop.status === 'pending' ? `<span class="dv-move"><button data-move="${stop.id}" data-direction="-1" data-focus="up-${stop.id}" aria-label="${escapeHtml(stop.name)} 위로" ${disabled(eligible[0] === stop || pending || !connected)}>${referenceIcon('up')}</button><button data-move="${stop.id}" data-direction="1" data-focus="down-${stop.id}" aria-label="${escapeHtml(stop.name)} 아래로" ${disabled(eligible.at(-1) === stop || pending || !connected)}>${referenceIcon('down')}</button></span>` : '<span class="dv-muted">고정</span>'}</li>`).join(''));
}
function move(id, target) {
  if (!draft || pending || !connected) return;
  draft = movePendingOrder(draft, view().deliveries, id, target); renderEditor();
}
function moveBy(id, direction) {
  if (!draft) return;
  const ids = draft.filter(id => view().deliveries.find(stop => stop.id === id)?.status === 'pending');
  const target = ids[ids.indexOf(id) + direction]; if (target) move(id, target);
}
function switchTab(value) {
  if (pending) return;
  tab = value; screen = 'main'; draft = null; feedback(''); render();
  if (tab === 'map') requestAnimationFrame(() => map.resize());
}
function showSheet(config) {
  if (pending) return;
  if (!sheet) returnFocus = document.activeElement;
  if (proofUrl) { URL.revokeObjectURL(proofUrl); proofUrl = null; }
  sheet = config;
  byId('dv-sheet-title').textContent = config.title;
  byId('dv-sheet-subtitle').textContent = config.subtitle || '';
  byId('dv-sheet-subtitle').hidden = !config.subtitle;
  byId('dv-sheet-body').innerHTML = config.body;
  byId('dv-sheet-body').scrollTop = 0;
  byId('dv-sheet-back').hidden = !config.back;
  byId('dv-sheet-close').disabled = false;
  byId('dv-sheet-layer').hidden = false;
  byId('dv-app').inert = true;
  byId('dv-sheet').focus({ preventScroll: true });
  return byId('dv-sheet-body');
}
function closeSheet(force = false) {
  if (pending && force !== true) return;
  sheet = null;
  if (proofUrl) { URL.revokeObjectURL(proofUrl); proofUrl = null; }
  proofCheckedIds.clear();
  byId('dv-sheet-layer').hidden = true;
  byId('dv-app').inert = false;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  else byId(`dv-tab-${tab}`).focus({ preventScroll: true });
}
function openRequest(id) {
  const stop = view().current;
  const request = stop?.customerRequests?.items?.find(item => item.id === id);
  if (!request) return;
  showSheet({ kind: 'request', stopId: stop.id, title: '고객 요청', subtitle: stop.name,
    body: renderCustomerRequests({ ...stop, customerRequests: { ...stop.customerRequests, items: [request] } }, { showSource: false }),
  });
}
function openDetail(id, nextTab = 'order') {
  const stop = driverTipDelivery(latest, id);
  if (!stop) return;
  detailTab = nextTab;
  const tabs = `<div class="dv-segments" role="group" aria-label="배송지 상세"><button data-detail="order" aria-pressed="${detailTab === 'order'}">주문 정보</button><button data-detail="destination" aria-pressed="${detailTab === 'destination'}">배송지 정보</button></div>`;
  const body = detailTab === 'order' ? `<dl class="dv-key-values"><div><dt>주문 번호</dt><dd>${escapeHtml(stop.orderNumber || stop.orderNo || '미제공')}</dd></div><div><dt>배송지</dt><dd>${escapeHtml(stop.name)}</dd></div><div><dt>상품 보관 조건</dt><dd>${escapeHtml(conditionText(stop))}</dd></div><div><dt>박스 수</dt><dd>${stop.boxes ?? '—'}박스</dd></div></dl><ul class="dv-items">${(stop.items || []).map(item => `<li><div><strong>${escapeHtml(item.name)}</strong><p class="dv-muted">${escapeHtml(item.opt)}</p></div><strong>×${escapeHtml(item.qty)}</strong></li>`).join('') || '<li class="dv-muted">상품 상세 정보가 제공되지 않았습니다.</li>'}</ul>` : `${renderCustomerRequests(stop, { showSource: false })}<dl class="dv-key-values"><div><dt>주소</dt><dd>${escapeHtml(stop.address)}</dd></div><div><dt>점심시간</dt><dd>등록된 정보 없음</dd></div></dl><label class="dv-field" for="driver-tip-body">배송원 팁</label><p class="dv-muted">고객 요청과 별도로 배송원이 작성하는 메모입니다.</p><textarea id="driver-tip-body" rows="4" maxlength="500" placeholder="출입 방법과 하차 위치를 적어 주세요.">${escapeHtml(tipDrafts.get(id) ?? stop.tip?.body ?? '')}</textarea><div class="dv-inline dv-muted"><span id="driver-tip-author"></span><span id="driver-tip-count"></span></div><button class="dv-button dv-primary" id="driver-tip-save" data-detail-save>배송 팁 저장</button><p class="dv-muted" id="driver-tip-status" role="status"></p>`;
  showSheet({ kind: 'detail', stopId: id, title: stop.name, subtitle: `${stop.sequence}번째 배송지`, body: tabs + body,
    onClick(event) {
      const detail = event.target.closest('[data-detail]');
      if (detail) openDetail(id, detail.dataset.detail);
      if (event.target.closest('[data-detail-save]')) saveTip(id);
    },
    onInput(event) { if (event.target.id === 'driver-tip-body') { tipDrafts.set(id, event.target.value); updateTip(); } },
  });
  updateTip();
}
function updateTip() {
  if (sheet?.kind !== 'detail' || !byId('driver-tip-body')) return;
  const stop = driverTipDelivery(latest, sheet.stopId);
  const textarea = byId('driver-tip-body');
  textarea.disabled = Boolean(pending) || dispatchReadOnly();
  byId('driver-tip-count').textContent = `${textarea.value.length}/500`;
  byId('driver-tip-author').textContent = stop?.tip ? `${stop.tip.author || '배송원'} (${stop.tip.updatedAt || '시각 미확인'})` : '작성 기록 없음';
  byId('driver-tip-save').disabled = !connected || pending || dispatchReadOnly() || !textarea.value.trim();
}
function saveTip(id) {
  const body = byId('driver-tip-body').value.trim();
  if (!body || pending || !connected) return;
  sendCommand('set_delivery_tip', { stopId: id, body }, state => driverTipDelivery(state, id)?.tip?.body === body, () => {
    tipDrafts.set(id, body); feedback('배송 팁을 저장했습니다.');
    if (sheet?.kind === 'detail' && sheet.stopId === id && byId('driver-tip-status')) byId('driver-tip-status').textContent = '배송 팁을 저장했습니다.';
  });
}
function openProof() {
  const model = view();
  if (!model.canComplete || pending || dispatchReadOnly()) return;
  const stop = model.current;
  const hasCustomerRequests = Boolean(stop.customerRequests?.items?.length);
  const proofPreview = () => proofUrl ? `<img src="${escapeHtml(proofUrl)}" alt="배송 증빙 사진 미리보기">` : `<div>${icon('photo')}배송 완료에 사진이 필요합니다.</div>`;
  const cameraBody = () => `<label class="dv-field" for="dv-proof-time">완료 시간</label><input id="dv-proof-time" value="${escapeHtml(latest.simClock)}" readonly><p class="dv-muted">현재 배송 시각으로 기록합니다.</p><p class="dv-field">배송 증빙 사진 (필수)</p><div class="dv-proof-preview" id="dv-proof-preview">${proofPreview()}</div><div class="dv-form-actions"><button class="dv-button" data-photo="camera">${proofUrl ? '재촬영' : '사진 촬영'}</button><button class="dv-button" data-photo="album">앨범에서 선택</button></div><input id="dv-proof-file" type="file" accept="image/*" hidden>${latest.sourceData ? '' : '<p class="dv-muted">사진은 이 화면에서만 미리보기 됩니다. 서버 사진 저장은 연결되지 않았습니다.</p>'}<div class="dv-form-actions"><button class="dv-button" data-proof-cancel>취소</button><button class="dv-button dv-primary" data-proof-next ${disabled(!proofUrl)}>${hasCustomerRequests ? '고객 요청 확인' : '완료 확인'}</button></div>`;
  const requestBody = () => `<section class="dv-request-confirm"><p class="dv-eyebrow">${hasCustomerRequests ? '고객 요청 이행 확인' : '배송 완료 확인'}</p><h3>${escapeHtml(stop.name)}</h3>${renderCustomerRequests(stop, { showSource: false, confirmation: true, checkedIds: [...proofCheckedIds] })}<dl class="dv-key-values"><div><dt>상품 보관 조건</dt><dd>${escapeHtml(conditionText(stop))}</dd></div><div><dt>배송원 팁</dt><dd>${escapeHtml(stop.tip?.body || '미등록')}</dd></div></dl><p class="dv-muted">상품 보관 조건과 배송원 팁은 고객 요청과 별도 정보입니다.</p><div class="dv-proof-thumb">${proofPreview()}</div><p class="dv-muted">${hasCustomerRequests ? '필수 고객 요청을 확인하면 배송이 완료됩니다.' : '사진을 확인한 뒤 배송 완료를 확정합니다.'}${latest.sourceData ? '' : ' 사진은 이 화면에서만 확인할 수 있으며 서버에 저장되지 않습니다.'}</p><button class="dv-button dv-primary" id="dv-proof-confirm" data-proof-confirm ${disabled(!completionProofCanSubmit(latest, connected, stop.id, proofUrl, [...proofCheckedIds]))}>확인하고 배송 완료</button></section>`;
  const config = { kind: 'proof', stopId: stop.id, requestSignature: requestSignature(stop), title: '배송 완료 사진', subtitle: `${stop.name} 배송 증빙을 촬영합니다.`, body: cameraBody(),
    onClick(event) {
      if (event.target.closest('[data-proof-cancel]')) closeSheet();
      const photo = event.target.closest('[data-photo]');
      if (photo?.dataset.photo === 'camera') {
        if (proofUrl) URL.revokeObjectURL(proofUrl);
        proofUrl = exampleProofUrl;
        proofCheckedIds.clear();
        byId('dv-sheet-body').innerHTML = cameraBody();
        return;
      }
      if (photo) {
        const input = byId('dv-proof-file');
        input.click();
      }
      if (event.target.closest('[data-proof-next]') && proofUrl) {
        proofCheckedIds.clear();
        byId('dv-sheet-title').textContent = hasCustomerRequests ? '고객 요청 확인' : '배송 완료 확인';
        byId('dv-sheet-subtitle').textContent = `${stop.name} ${hasCustomerRequests ? '배송 전 확인' : '사진 확인'}`;
        byId('dv-sheet-back').hidden = false;
        config.back = () => {
          proofCheckedIds.clear();
          byId('dv-sheet-title').textContent = '배송 완료 사진';
          byId('dv-sheet-subtitle').textContent = `${stop.name} 배송 증빙을 촬영합니다.`;
          byId('dv-sheet-body').innerHTML = cameraBody();
          byId('dv-sheet-back').hidden = true;
        };
        byId('dv-sheet-body').innerHTML = requestBody();
      }
      if (event.target.closest('[data-proof-confirm]') && completionProofCanSubmit(latest, connected, stop.id, proofUrl, [...proofCheckedIds]) && view().current?.id === stop.id) {
        sendCommand('complete_stop', { stopId: stop.id, confirmedRequestIds: [...proofCheckedIds], hasPhoto: true }, state => state.deliveries.find(item => item.id === stop.id)?.status === 'done', () => { closeSheet(); feedback(`${stop.name} 배송 완료를 기록했습니다.`); });
      }
    },
    onInput(event) {
      if (event.target.matches('[data-request-check]')) {
        event.target.checked ? proofCheckedIds.add(event.target.dataset.requestCheck) : proofCheckedIds.delete(event.target.dataset.requestCheck);
        const confirm = byId('dv-proof-confirm');
        if (confirm) confirm.disabled = dispatchReadOnly() || !completionProofCanSubmit(latest, connected, stop.id, proofUrl, [...proofCheckedIds]);
        return;
      }
      if (event.target.id !== 'dv-proof-file') return;
      const file = event.target.files[0]; if (!file || !file.type.startsWith('image/')) return;
      if (proofUrl) URL.revokeObjectURL(proofUrl);
      proofUrl = URL.createObjectURL(file);
      proofCheckedIds.clear();
      byId('dv-sheet-body').innerHTML = cameraBody();
    },
  };
  showSheet(config);
}

byId('dv-settings').innerHTML = icon('settings'); byId('dv-logout').innerHTML = icon('logout');
byId('dv-sheet-close').innerHTML = icon('close'); byId('dv-sheet-back').innerHTML = icon('back');
byId('dv-tab-delivery').innerHTML = `${icon('package')}배송`; byId('dv-tab-map').innerHTML = `${icon('map')}지도`;
byId('dv-settings').addEventListener('click', () => openDriverSettings(showSheet));
byId('dv-logout').addEventListener('click', () => showSheet({ title: '로그아웃', body: `<p class="dv-muted">${latest?.sourceData ? '계정 로그아웃은 포털에서 할 수 있습니다.' : '배송원 뷰어는 현재 데모 계정으로 열려 있습니다. 계정 로그아웃은 포털에서 할 수 있습니다.'}</p><a class="dv-button" href="/">포털로 이동</a>` }));
byId('dv-sheet-close').addEventListener('click', closeSheet);
byId('dv-sheet-back').addEventListener('click', () => { if (!pending) sheet?.back?.(); });
byId('dv-sheet-layer').addEventListener('click', event => { if (event.target === byId('dv-sheet-layer')) closeSheet(); });
byId('dv-sheet-body').addEventListener('click', event => { if (!pending) sheet?.onClick?.(event); });
byId('dv-sheet-body').addEventListener('input', event => sheet?.onInput?.(event));
byId('driver-vehicle-select').addEventListener('change', event => {
  const stop = latest.fleetDeliveries.find(stop => stop.vehicle?.id === event.target.value);
  if (stop) selectVehicle(stop.id);
});
byId('dv-select-today').addEventListener('click', () => { byId('dv-route-choice').open = false; screen = 'main'; render(); });
byId('dv-app').addEventListener('click', event => {
  if (pending) return;
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.dataset.tab) switchTab(target.dataset.tab);
  if (target.dataset.group) { group = target.dataset.group; tab = 'delivery'; screen = 'main'; draft = null; render(); }
  if (target.dataset.historyDate) { historyDate = target.dataset.historyDate; renderHistory(); }
  if (target.dataset.historyMonth) { historyDate = shiftHistoryMonth(historyDate, Number(target.dataset.historyMonth)); renderHistory(); }
  if (target.dataset.orders) { orderGroup = target.dataset.orders; renderOrders(); }
  if (target.dataset.stop) openDetail(target.dataset.stop);
  if (target.dataset.requestInfo) openRequest(target.dataset.requestInfo);
  if (target.dataset.move) moveBy(target.dataset.move, Number(target.dataset.direction));
  if (target.dataset.assignment) showSheet({ title: target.dataset.assignment === 'return' ? '배송 반납' : '배송 전달', body: '<p class="dv-muted">배차 변경 기능이 연결되면 이용할 수 있습니다.</p><button class="dv-button dv-primary" disabled>배차 변경 대기</button>' });
  switch (target.dataset.action) {
    case 'retry-history': historyCache.delete(historySelectionKey); renderHistory(); break;
    case 'orders': screen = 'orders'; render(); break;
    case 'back': screen = 'main'; render(); break;
    case 'edit': beginEdit(); break;
    case 'cancel-edit': draft = null; screen = 'main'; render(); break;
    case 'save-edit': {
      if (!draft || signature() !== base.signature) { feedback('배송 상태를 다시 확인한 뒤 편집해 주세요.'); break; }
      const order = [...draft];
      sendCommand('set_route_order', { order, expectedOrder: base.order, expectedStatuses: base.statuses, expectedPhase: base.phase }, state => state.deliveries.every((stop, index) => stop.id === order[index]), () => { draft = null; screen = 'main'; feedback('배송 순서를 저장했습니다.'); });
      break;
    }
    case 'open-map': switchTab('map'); break;
    case 'complete': openProof(); break;
    case 'start': {
      const stop = view().deliveries.find(stop => stop.status === 'pending');
      if (dispatchReadOnly() || latest.phase !== 'preparing' || view().vehicle?.live === false || !stop) break;
      const startSignature = signature();
      showSheet({ kind: 'start', startSignature, title: '배송 시작', body: '<p class="dv-muted">픽업을 마쳤나요? 첫 배송지로 출발합니다.</p><button class="dv-button dv-primary" data-confirm-start>배송 시작</button>', onClick(event) {
        if (event.target.closest('[data-confirm-start]') && signature() === startSignature) sendCommand('set_scenario', { scenario: 'shipping', stopId: stop.id }, state => state.phase === 'delivering', () => { closeSheet(); feedback('배송을 시작했습니다.'); });
      } });
      break;
    }
  }
});
byId('dv-app').addEventListener('change', event => {
  if (event.target.id === 'dv-history-driver') { historyVehicleId = event.target.value; renderHistory(); }
});
byId('dv-edit-map-toggle').addEventListener('click', () => { editMapOpen = !editMapOpen; renderEditor(); if (editMapOpen) requestAnimationFrame(() => editMap.resize()); });
byId('dv-edit-list').addEventListener('keydown', event => {
  const handle = event.target.closest('[data-handle]');
  if (handle && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); moveBy(handle.dataset.handle, event.key === 'ArrowUp' ? -1 : 1); }
});
byId('dv-edit-list').addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-handle]');
  if (!handle || handle.disabled || !event.isPrimary || event.button !== 0) return;
  event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
  drag = { pointer: event.pointerId, id: handle.dataset.handle, target: null };
});
byId('dv-edit-list').addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return;
  const list = byId('dv-edit-list');
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-route-id]');
  list.querySelectorAll('[data-drop]').forEach(item => item.removeAttribute('data-drop'));
  drag.target = row && list.contains(row) ? row.dataset.routeId : null;
  if (view().deliveries.find(stop => stop.id === drag.target)?.status === 'pending') row.dataset.drop = 'true';
  const bounds = list.getBoundingClientRect();
  if (event.clientY > bounds.bottom - 40) list.scrollBy(0, 16);
  if (event.clientY < bounds.top + 40) list.scrollBy(0, -16);
});
function endDrag(event) {
  if (drag?.pointer !== event.pointerId) return;
  const { id, target } = drag; drag = null;
  byId('dv-edit-list').querySelectorAll('[data-drop]').forEach(item => item.removeAttribute('data-drop'));
  if (event.type === 'pointerup' && target) move(id, target);
  renderEditor();
}
byId('dv-edit-list').addEventListener('pointerup', endDrag);
byId('dv-edit-list').addEventListener('pointercancel', endDrag);
byId('dv-app').addEventListener('keydown', event => {
  if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); switchTab(tab === 'delivery' ? 'map' : 'delivery'); byId(`dv-tab-${tab}`).focus(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (sheet) closeSheet(); else if (draft && !pending) { draft = null; screen = 'main'; render(); } }
  if (!sheet || event.key !== 'Tab') return;
  const focusable = [...byId('dv-sheet').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea,select')].filter(item => item.offsetParent !== null);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === byId('dv-sheet'))) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && (document.activeElement === last || document.activeElement === byId('dv-sheet'))) { event.preventDefault(); first?.focus(); }
});
window.addEventListener('resize', () => { if (tab === 'map') map.resize(); if (screen === 'edit' && editMapOpen) editMap.resize(); });
