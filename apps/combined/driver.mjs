import { adaptSimulation } from './simulation-adapter.mjs';
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
import { driverHistoryForDate, exampleHistoryDates } from './driver-history.mjs';
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
let latest, connected = false, selectedId = new URLSearchParams(location.search).get('id');
let tab = 'delivery', screen = 'main', group = null, routeCompleted = null, orderGroup = 'own', mapSelection = null;
let draft = null, base = null, editMapOpen = true, drag = null, pending = null, pendingTimer;
let sheet = null, returnFocus = null, proofUrl = null, detailTab = 'order';
let proofCheckedIds = new Set();
let historyDate = new Date().toLocaleDateString('sv-SE');
const tipDrafts = new Map();
const shell = mountDemoShell({ viewer: 'driver', onSend: (type, extra) => simulation.send(type, extra) });
shell.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    latest = adaptSimulation(raw);
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
const eta = stop => stop?.completedAt || stop?.preciseTimeText || stop?.officialEta?.time || '—';
const conditionText = stop => [...new Set((stop.items || []).flatMap(item => ['냉장', '냉동'].filter(condition => String(item.name).includes(condition))))].join(' / ') || '운송 조건 미등록';
const summary = deliveries => `${deliveries.length}곳 <span>${deliveries.reduce((sum, stop) => sum + (stop.boxes || 0), 0)}박스</span>`;
const requestSignature = stop => JSON.stringify((stop?.customerRequests?.items || []).map(item => item.id));
const compactRequest = stop => {
  const html = renderCustomerRequests(stop, { compact: true });
  return html ? `<span class="dv-current-request">${html}</span>` : '';
};
function feedback(message) { byId('dv-feedback').textContent = message; byId('dv-feedback').hidden = !message; }
function failCommand(message) { clearTimeout(pendingTimer); pending = null; feedback(message); if (latest) render(); }
function sendCommand(type, payload, accept, done) {
  if (!connected || pending) return;
  pending = { accept, done };
  feedback('저장 중입니다.');
  simulation.send(type, payload);
  pendingTimer = setTimeout(() => failCommand('서버 응답을 확인하지 못했습니다. 상태를 확인한 뒤 다시 시도해 주세요.'), 5000);
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
function selectVehicle(id) {
  if (pending) return;
  selectedId = id; mapSelection = null; draft = null; screen = 'main'; group = null; routeCompleted = null;
  const url = new URL(location.href); url.searchParams.set('id', id); history.replaceState(null, '', url);
  shell.select(id); closeSheet(); feedback(''); render();
}
function render() {
  if (!latest) return;
  if (!selectedId) selectedId = latest.customerStopId || latest.deliveries[0]?.id;
  const model = view();
  selectedId = model.selected?.id || selectedId;
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
  byId('driver-name').textContent = `${model.vehicle?.driver || '배송원 미확인'}${model.vehicle?.driver ? ' 배송원' : ''}`;
  byId('driver-vehicle').textContent = model.vehicle?.plate || '미확인';
  byId('driver-region').textContent = model.vehicle?.region || '미등록';
  byId('driver-done').textContent = model.progress;
  byId('driver-left').textContent = `${model.remainingBoxes}박스`;
  byId('driver-finish').textContent = model.finishEta;
  byId('driver-manage-link').href = `/combined/?id=${encodeURIComponent(selectedId)}#/control/manage`;
  const vehicles = latest.fleetVehicles?.length ? latest.fleetVehicles : [model.vehicle].filter(Boolean);
  const select = byId('driver-vehicle-select');
  const options = vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate)} / ${escapeHtml(vehicle.driver)}</option>`).join('');
  if (select._html !== options) { select.innerHTML = options; select._html = options; }
  select.value = model.vehicle?.id || ''; select.disabled = Boolean(pending);
  byId('dv-route-label').textContent = model.vehicle?.plate || '배차 미확인';
  byId('dv-route-status').textContent = model.status;
  byId('dv-select-today').disabled = !activeRoute();
  document.querySelectorAll('[data-group]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.group === group)); button.disabled = Boolean(pending); });
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab)); button.tabIndex = button.dataset.tab === tab ? 0 : -1; button.disabled = Boolean(pending) || group === 'history';
  });
  byId('dv-settings').disabled = byId('dv-logout').disabled = Boolean(pending);
  if (draft && !pending && signature() !== base.signature) {
    draft = null; drag = null; screen = 'main'; feedback('배송 상태가 바뀌어 편집을 종료했습니다. 최신 순서에서 다시 편집해 주세요.');
  }
  byId('dv-route-selector').hidden = screen === 'edit';
  byId('dv-route-choice').hidden = group === 'history';
  byId('dv-delivery').hidden = screen !== 'main' || tab !== 'delivery' || group === 'history';
  byId('dv-map-panel').hidden = screen !== 'main' || tab !== 'map' || group === 'history';
  byId('dv-history').hidden = screen !== 'main' || group !== 'history';
  byId('dv-orders').hidden = screen !== 'orders';
  byId('dv-editor').hidden = screen !== 'edit';
  if (screen === 'edit') renderEditor();
  else if (screen === 'orders') renderOrders();
  else if (group === 'history') renderHistory();
  else if (tab === 'delivery') renderDelivery();
  else {
    mapSelection = driverMapDelivery(model.deliveries, mapSelection)?.id || null;
    map.update(activeRoute() ? model.deliveries : [], latest.truck?.dwelling);
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
    if (confirm) confirm.disabled = !completionProofCanSubmit(latest, connected, sheet.stopId, proofUrl, [...proofCheckedIds]) || Boolean(pending);
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
  if (model.vehicle?.live === false) return '<p class="dv-muted">조회 전용 배차입니다.</p>';
  if (latest.phase === 'done') return '<p class="dv-muted">모든 배송을 완료했습니다.</p>';
  if (latest.phase !== 'delivering') return `<button class="dv-button dv-primary dv-start" aria-label="배송 시작" data-action="start" ${disabled(!connected || latest.phase !== 'preparing' || pending)}><span>배송 시작</span><small>픽업 완료</small></button>`;
  return `<div class="dv-inline"><button class="dv-button dv-soft" data-action="open-map">지도 열기</button><button class="dv-button dv-primary" data-action="complete" ${disabled(!model.canComplete || pending)}>배송 완료</button></div>${model.canComplete ? '' : '<p class="dv-action-hint">배송지에 도착하면 완료할 수 있습니다.</p>'}`;
}
function renderDelivery() {
  if (!activeRoute()) return;
  const model = view();
  const departure = model.deliveries[0]?.timeline?.find(item => item.label === '배송 중')?.time || '출발 전';
  patch('dv-delivery', `<header class="dv-delivery-heading"><div><h2>금일 배차</h2><p>${summary(model.deliveries)}</p></div><div class="dv-heading-actions"><button class="dv-button dv-soft" data-action="orders">주문 목록</button><button class="dv-button dv-primary" data-action="edit" ${disabled(model.vehicle?.live === false || !connected || pending || model.deliveries.filter(stop => stop.status === 'pending').length < 2)}>순서 편집</button></div></header><section class="dv-today-status" aria-label="금일 진행 및 완료 현황"><div><span>진행·대기</span><strong>${model.todayCounts.active}곳</strong></div><div><span>완료</span><strong>${model.todayCounts.done}곳</strong></div><div><span>보류</span><strong>${model.todayCounts.skipped}곳</strong></div></section><section class="dv-eta" aria-label="배송 예상 시간"><div><span>배송 시작</span><strong>${escapeHtml(departure)}</strong></div>${icon('arrow')}<div><span>마지막 배송</span><strong>${escapeHtml(model.finishEta)}</strong></div></section><section class="dv-execution"><p class="dv-eyebrow">${latest.phase === 'done' ? '완료된 배차' : '지금 가는 배송지'}</p>${compactRequest(model.current)}<h3>${escapeHtml(model.destination)}</h3><p class="dv-muted">${escapeHtml(model.address)}</p>${executionButtons()}</section><ol class="dv-route">${model.deliveries.map(stop => `<li>${stopCard(stop)}</li>`).join('')}</ol>`);
}
function renderHistory() {
  const history = driverHistoryForDate(historyDate);
  const dates = exampleHistoryDates.map(date => `<button class="dv-history-date" data-history-date="${date}">${date.slice(5).replace('-', '.')}</button>`).join('');
  const records = history.map(item => `<article class="dv-history-card"><header><div><span class="dv-demo-badge">예시</span><h3>${escapeHtml(item.label)}</h3></div><strong>${escapeHtml(item.vehicle)}</strong></header><dl class="dv-key-values"><div><dt>근무 시간</dt><dd>${item.startedAt}–${item.endedAt}</dd></div><div><dt>배송 규모</dt><dd>${item.destinations}곳 / ${item.boxes}박스</dd></div></dl></article>`).join('');
  patch('dv-history', `<header class="dv-delivery-heading"><div><h2>근무 이력</h2><p>운영 이력 서비스와 분리된 화면 확인용 더미입니다.</p></div></header><div class="dv-history-picker"><label class="dv-field" for="dv-history-date">조회 날짜</label><input id="dv-history-date" type="date" value="${historyDate}"><div class="dv-history-dates"><span>예시 제공 날짜</span>${dates}</div></div>${records || '<div class="dv-empty">선택한 날짜의 예시 기록이 없습니다.<span class="dv-muted">현재 완료 목록을 과거 이력으로 사용하지 않습니다.</span></div>'}`);
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
  patch('dv-orders', `<header class="dv-subheader"><button class="dv-text-button" data-action="back">뒤로</button><h2>주문 목록</h2><span></span></header><div class="dv-delivery-heading"><div><h2>오늘 배송</h2><p>${summary(model.deliveries)}</p></div></div><div class="dv-segments dv-order-segments" role="group" aria-label="주문 구분"><button data-orders="own" aria-pressed="${orderGroup === 'own'}">내 배송</button><button data-orders="common" aria-pressed="${orderGroup === 'common'}">공용 배송</button></div>${orderGroup === 'common' ? '<div class="dv-empty">공용 배송에 등록된 주문이 없습니다.</div>' : `<ol class="dv-route">${model.deliveries.map(stop => `<li>${stopCard(stop)}<div class="dv-order-actions"><button class="dv-button" data-assignment="return" data-stop-id="${stop.id}" ${disabled(['done','skipped'].includes(stop.status))}>반납</button><button class="dv-button dv-soft" data-assignment="transfer" data-stop-id="${stop.id}" ${disabled(['done','skipped'].includes(stop.status))}>전달</button></div></li>`).join('')}</ol>`}`);
}
function beginEdit() {
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
  byId('dv-save-order').disabled = Boolean(pending) || !connected || draft.every((id, index) => id === base.order[index]);
  byId('dv-edit-map').hidden = !editMapOpen;
  byId('dv-edit-map-toggle').textContent = editMapOpen ? '지도 접기' : '지도 보기';
  byId('dv-edit-map-toggle').setAttribute('aria-expanded', String(editMapOpen));
  if (editMapOpen) editMap.update(stops.map((stop, index) => ({ ...stop, sequence: index + 1 })), latest.truck?.dwelling, true);
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
function openDetail(id, nextTab = 'order') {
  const stop = driverTipDelivery(latest, id);
  if (!stop) return;
  detailTab = nextTab;
  const tabs = `<div class="dv-segments" role="group" aria-label="배송지 상세"><button data-detail="order" aria-pressed="${detailTab === 'order'}">주문 정보</button><button data-detail="destination" aria-pressed="${detailTab === 'destination'}">배송지 정보</button></div>`;
  const body = detailTab === 'order' ? `<dl class="dv-key-values"><div><dt>배송지</dt><dd>${escapeHtml(stop.name)}</dd></div><div><dt>상품 보관 조건</dt><dd>${escapeHtml(conditionText(stop))}</dd></div><div><dt>박스 수</dt><dd>${stop.boxes ?? '—'}박스</dd></div></dl><ul class="dv-items">${(stop.items || []).map(item => `<li><div><strong>${escapeHtml(item.name)}</strong><p class="dv-muted">${escapeHtml(item.opt)}</p></div><strong>×${escapeHtml(item.qty)}</strong></li>`).join('') || '<li class="dv-muted">상품 정보가 등록되지 않았습니다.</li>'}</ul>` : `${renderCustomerRequests(stop)}<dl class="dv-key-values"><div><dt>주소</dt><dd>${escapeHtml(stop.address)}</dd></div><div><dt>점심시간</dt><dd>등록된 정보 없음</dd></div></dl><label class="dv-field" for="driver-tip-body">배송원 팁</label><p class="dv-muted">고객 요청과 별도로 배송원이 작성하는 메모입니다.</p><textarea id="driver-tip-body" rows="4" maxlength="500" placeholder="출입 방법과 하차 위치를 적어 주세요.">${escapeHtml(tipDrafts.get(id) ?? stop.tip?.body ?? '')}</textarea><div class="dv-inline dv-muted"><span id="driver-tip-author"></span><span id="driver-tip-count"></span></div><button class="dv-button dv-primary" id="driver-tip-save" data-detail-save>배송 팁 저장</button><p class="dv-muted" id="driver-tip-status" role="status"></p>`;
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
  textarea.disabled = Boolean(pending);
  byId('driver-tip-count').textContent = `${textarea.value.length}/500`;
  byId('driver-tip-author').textContent = stop?.tip ? `${stop.tip.author || '배송원'} (${stop.tip.updatedAt || '시각 미확인'})` : '작성 기록 없음';
  byId('driver-tip-save').disabled = !connected || pending || !textarea.value.trim();
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
  if (!model.canComplete || pending) return;
  const stop = model.current;
  const proofPreview = () => proofUrl ? `<img src="${escapeHtml(proofUrl)}" alt="배송 증빙 사진 미리보기">` : `<div>${icon('photo')}배송 완료에 사진이 필요합니다.</div>`;
  const cameraBody = () => `<label class="dv-field" for="dv-proof-time">완료 시간</label><input id="dv-proof-time" value="${escapeHtml(latest.simClock)}" readonly><p class="dv-muted">현재 배송 시각으로 기록합니다.</p><p class="dv-field">배송 증빙 사진 (필수)</p><div class="dv-proof-preview" id="dv-proof-preview">${proofPreview()}</div><div class="dv-form-actions"><button class="dv-button" data-photo="camera">${proofUrl ? '재촬영' : '사진 촬영'}</button><button class="dv-button" data-photo="album">앨범에서 선택</button></div><input id="dv-proof-file" type="file" accept="image/*" hidden><p class="dv-muted">사진은 이 화면에서만 미리보기 됩니다. 서버 사진 저장은 연결되지 않았습니다.</p><div class="dv-form-actions"><button class="dv-button" data-proof-cancel>취소</button><button class="dv-button dv-primary" data-proof-next ${disabled(!proofUrl)}>고객 요청 확인</button></div>`;
  const requestBody = () => `<section class="dv-request-confirm"><p class="dv-eyebrow">고객 요청 이행 확인</p><h3>${escapeHtml(stop.name)}</h3>${renderCustomerRequests(stop, { confirmation: true, checkedIds: [...proofCheckedIds] })}<dl class="dv-key-values"><div><dt>상품 보관 조건</dt><dd>${escapeHtml(conditionText(stop))}</dd></div><div><dt>배송원 팁</dt><dd>${escapeHtml(stop.tip?.body || '미등록')}</dd></div></dl><p class="dv-muted">상품 보관 조건과 배송원 팁은 고객 요청과 별도 정보입니다.</p><div class="dv-proof-thumb">${proofPreview()}</div><p class="dv-muted">필수 고객 요청을 확인하면 배송이 완료됩니다. 사진은 이 화면에서만 확인할 수 있으며 서버에 저장되지 않습니다.</p><button class="dv-button dv-primary" id="dv-proof-confirm" data-proof-confirm ${disabled(!completionProofCanSubmit(latest, connected, stop.id, proofUrl, [...proofCheckedIds]))}>확인하고 배송 완료</button></section>`;
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
        byId('dv-sheet-title').textContent = '고객 요청 확인';
        byId('dv-sheet-subtitle').textContent = `${stop.name} 배송 전 확인`;
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
        sendCommand('complete_stop', { stopId: stop.id, confirmedRequestIds: [...proofCheckedIds] }, state => state.deliveries.find(item => item.id === stop.id)?.status === 'done', () => { closeSheet(); feedback(`${stop.name} 배송 완료를 기록했습니다.`); });
      }
    },
    onInput(event) {
      if (event.target.matches('[data-request-check]')) {
        event.target.checked ? proofCheckedIds.add(event.target.dataset.requestCheck) : proofCheckedIds.delete(event.target.dataset.requestCheck);
        const confirm = byId('dv-proof-confirm');
        if (confirm) confirm.disabled = !completionProofCanSubmit(latest, connected, stop.id, proofUrl, [...proofCheckedIds]);
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
byId('dv-logout').addEventListener('click', () => showSheet({ title: '로그아웃', body: '<p class="dv-muted">배송원 뷰어는 현재 데모 계정으로 열려 있습니다. 계정 로그아웃은 포털에서 할 수 있습니다.</p><a class="dv-button" href="/">포털로 이동</a>' }));
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
  if (target.dataset.orders) { orderGroup = target.dataset.orders; renderOrders(); }
  if (target.dataset.stop) openDetail(target.dataset.stop);
  if (target.dataset.move) moveBy(target.dataset.move, Number(target.dataset.direction));
  if (target.dataset.assignment) showSheet({ title: target.dataset.assignment === 'return' ? '배송 반납' : '배송 전달', body: '<p class="dv-muted">배차 변경 기능이 연결되면 이용할 수 있습니다.</p><button class="dv-button dv-primary" disabled>배차 변경 대기</button>' });
  switch (target.dataset.action) {
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
      if (latest.phase !== 'preparing' || view().vehicle?.live === false || !stop) break;
      const startSignature = signature();
      showSheet({ kind: 'start', startSignature, title: '배송 시작', body: '<p class="dv-muted">픽업을 마쳤나요? 첫 배송지로 출발합니다.</p><button class="dv-button dv-primary" data-confirm-start>배송 시작</button>', onClick(event) {
        if (event.target.closest('[data-confirm-start]') && signature() === startSignature) sendCommand('set_scenario', { scenario: 'shipping', stopId: stop.id }, state => state.phase === 'delivering', () => { closeSheet(); feedback('배송을 시작했습니다.'); });
      } });
      break;
    }
  }
});
byId('dv-app').addEventListener('input', event => {
  if (event.target.id === 'dv-history-date') { historyDate = event.target.value; renderHistory(); }
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
