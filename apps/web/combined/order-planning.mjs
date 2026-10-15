import { createOrderMap, createOrderMarker, orderMapModel } from '../src/shared/maps/order-map.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
import { vehicleOperations } from './vehicle-operations-model.mjs';
import { mountDispatchMapLayers } from './dispatch-map-layer.mjs';
import { PAGE_SIZE, paginate } from './pagination-model.mjs';
import { bundleDeliveries } from './delivery-bundles.mjs';
import { geometryBounds, volumeLines, weightText, withZoneVolumes, zoneVolumes } from './zone-volume.mjs';
import { isUnverifiedVehicle, locationLabel, plateLabel } from './vehicle-identity.mjs';
import { driverNamesText, transferZoneOptions, zoneDrivers } from './zone-transfer.mjs';
import { addUnits, pointsInRectangle, pruneSelection, summarizeSelection, toggleUnits, transferPreview } from './bulk-selection.mjs';
export { createOrderMap, createOrderMarker, orderMapModel };

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function totalBoxes(deliveries) {
  const total = Array.isArray(deliveries) && deliveries.every(delivery => Number.isFinite(delivery?.boxes) && delivery.boxes >= 0)
    ? deliveries.reduce((sum, delivery) => sum + delivery.boxes, 0) : null;
  return Number.isFinite(total) ? total : null;
}

const deliveriesFor = data => Array.isArray(data?.fleetDeliveries) ? data.fleetDeliveries : Array.isArray(data?.deliveries) ? data.deliveries : null;
const vehiclesFor = data => Array.isArray(data?.fleetVehicles) ? data.fleetVehicles : data?.vehicle ? [data.vehicle] : [];
const boxesText = boxes => Number.isFinite(boxes) && boxes >= 0 ? `${boxes.toLocaleString('ko-KR')}박스` : '미확인';
const vehicleIdFor = (delivery, fallbackVehicleId) => delivery?.vehicle?.id ?? delivery?.vehicleId ?? fallbackVehicleId ?? null;
const countText = count => `${Number(count || 0).toLocaleString('ko-KR')}곳`;
const planningVehicles = data => {
  const vehicles = vehiclesFor(data);
  if (!data?.dispatchSource || !data?.dispatch || data.dispatch.phase === 'unplanned') return vehicles;
  const assignedIds = new Set((deliveriesFor(data) || []).map(stop => vehicleIdFor(stop)));
  return vehicles.filter(vehicle => assignedIds.has(vehicle.id));
};
const planningOperations = data => {
  if (!data?.dispatchSource) return vehicleOperations(data);
  const actual = new Map((data.sourceOrders || []).map(order => [order.id, order]));
  return vehicleOperations({ ...data,
    sourceData: data.sourceData || { date: data.dispatchSource.date },
    fleetVehicles: data?.dispatch?.phase === 'unplanned' ? [] : planningVehicles(data),
    fleetDeliveries: data?.dispatch?.phase === 'published' && Array.isArray(data.sourceOrders) ? data.sourceOrders : (deliveriesFor(data) || []).map(order => {
      const recorded = actual.get(order.id);
      return recorded?.vehicleId === order.vehicleId ? { ...recorded, ...order } : order;
    }),
  });
};
const clockText = (value, date) => {
  if (!Number.isFinite(value)) return '미확인';
  if (date) value -= Date.parse(`${date}T00:00:00+09:00`);
  const totalMinutes = Math.round(value / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const minutes = totalMinutes % (24 * 60);
  const day = days === 0 ? '' : days === 1 ? '다음날 ' : `+${days}일 `;
  return `${day}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
export function regionOrderCounts(regions, deliveries) {
  if (regions?.type !== 'FeatureCollection' || !Array.isArray(regions.features)) return null;
  const counts = new Map();
  for (const delivery of deliveries || []) {
    for (const zoneId of new Set(Array.isArray(delivery?.zoneIds) ? delivery.zoneIds : [])) {
      if (typeof zoneId === 'string' && zoneId) counts.set(zoneId, (counts.get(zoneId) || 0) + 1);
    }
  }
  return { ...regions, features: regions.features.map(feature => ({
    ...feature,
    properties: { ...feature.properties, orderCount: counts.get(feature.properties?.zoneId) || 0 },
  })) };
}

export function mountOrderPlanning({
  element,
  onSelect = () => {},
  onAssign,
  loadRouteData = null,
  mapFactory = createOrderMap,
  markerFactory = createOrderMarker,
  layerFactory = mountDispatchMapLayers,
}) {
  if (!element) throw new TypeError('주문 배차 영역이 필요합니다.');
  element.innerHTML = `
    <div class="order-planning-layout">
    <aside class="panel order-vehicle-panel" aria-labelledby="order-vehicle-heading">
      <div class="order-vehicle-heading"><div><h2 id="order-vehicle-heading" data-order-group-heading>배차 차량</h2><p data-order-group-note>수신 순서</p></div></div>
      <div class="order-vehicle-list" data-order-vehicle aria-label="배차 차량 선택"></div>
    </aside>
    <section class="panel order-map-panel" aria-labelledby="order-map-heading">
      <h2 id="order-map-heading" class="sr-only">주문 배차 지도</h2>
      <div class="order-map-canvas" data-order-map-canvas aria-label="주문 위치">
        <div class="order-map-layer" data-order-map-layer></div>
        <div class="order-select-box" data-order-select-box hidden></div>
        <div class="order-map-popup" data-order-popup hidden></div>
        <div class="order-zone-hover" data-order-zone-hover aria-hidden="true" hidden></div>
        <div class="order-map-status" data-order-map-status role="status"><span data-order-map-status-text>지도 준비 중</span><button type="button" class="button subtle" data-order-map-retry hidden>다시 시도</button></div>
        <section class="order-map-selection" data-order-selection aria-live="polite"><span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong></section>
        <p class="order-map-summary" data-order-map-summary>총 물량 확인 중</p>
        <p class="order-map-count" data-order-map-count>위치 데이터 확인 중</p>
        <div class="order-map-tools"><div class="order-dispatch-actions" data-order-dispatch-actions hidden><button type="button" class="button subtle" data-order-dispatch-pin disabled>핀배차</button><div class="order-multi-actions" data-order-multi-actions><button type="button" class="button subtle" data-order-multi-toggle aria-pressed="false" disabled>복수 선택</button><button type="button" class="button primary" data-order-multi-transfer disabled>선택 이관</button><button type="button" class="button subtle" data-order-multi-clear disabled>선택 해제</button></div><p class="order-multi-summary" data-order-multi-summary role="status"></p><p class="order-dispatch-context" data-order-dispatch-context></p><p data-order-dispatch-result role="status" hidden></p></div></div>
        <div class="order-map-mode-wrap"><fieldset class="order-map-mode" data-order-map-mode-control hidden><legend class="sr-only">지도 표시 단위</legend><label><input type="radio" name="order-map-mode" value="regions" data-order-map-mode checked><span>권역 단위</span></label><label><input type="radio" name="order-map-mode" value="orders" data-order-map-mode><span>주문 단위</span></label></fieldset></div>
      </div>
      <details class="order-zone-volume" data-order-zone-panel open hidden><summary>권역별 물량 <span data-order-zone-total></span></summary>
        <div class="order-zone-body">
        <div class="order-zone-table-wrap"><table class="order-zone-table"><thead><tr><th scope="col">권역</th><th scope="col">착지</th><th scope="col">박스</th><th scope="col">주문</th><th scope="col">중량</th><th scope="col">배송원</th></tr></thead><tbody data-order-zone-rows></tbody></table></div>
        <div class="order-list-pages"><button type="button" class="button subtle" data-order-zone-previous>이전</button><span data-order-zone-page></span><button type="button" class="button subtle" data-order-zone-next>다음</button></div></div>
      </details>
    </section>
    </div>
    <details class="order-source-list" data-order-list-panel hidden><summary>주문 목록으로 찾기 <span data-order-list-total></span></summary><div class="order-source-list-content"><label>주문 검색<input type="search" data-order-search placeholder="결제번호, 주소, 기사 검색"></label><div data-order-list></div><div class="order-list-pages"><button type="button" class="button subtle" data-order-previous>이전</button><span data-order-page></span><button type="button" class="button subtle" data-order-next>다음</button></div></div></details>
    <dialog class="order-dialog order-reassign-dialog" data-order-reassign-dialog aria-labelledby="order-reassign-title">
      <div class="order-dialog-body"><div class="order-dialog-heading"><h2 id="order-reassign-title" data-order-reassign-title>핀배차</h2><button type="button" class="order-dialog-close" data-order-reassign-close aria-label="배차 창 닫기">${referenceIcon('close')}</button></div>
      <p class="order-dialog-description" data-order-reassign-from></p>
      <label class="order-reassign-target" data-order-reassign-zone-label hidden>대상 권역<select data-order-reassign-zone aria-label="대상 권역"></select></label>
      <label class="order-reassign-target">배정할 차량<select data-order-reassign-target aria-label="배정할 차량"></select></label>
      <p class="order-reassign-preview" data-order-reassign-preview></p><p class="order-dialog-description">같은 이름과 주소의 주문을 하나의 배송지로 묶어 배차 계산안에 반영합니다.</p>
      <p class="order-reassign-error" data-order-reassign-error role="alert" hidden></p>
      <div class="order-reassign-footer"><button type="button" class="button subtle" data-order-reassign-cancel>취소</button><button type="button" class="button primary" data-order-reassign-confirm>배차 적용</button></div></div>
    </dialog>`;

  const query = selector => element.querySelector(selector);
  const vehicleSelect = query('[data-order-vehicle]');
  const canvas = query('[data-order-map-canvas]');
  const layer = query('[data-order-map-layer]');
  const mapStatus = query('[data-order-map-status]');
  const mapStatusText = query('[data-order-map-status-text]');
  const mapRetry = query('[data-order-map-retry]');
  const count = query('[data-order-map-count]');
  const selection = query('[data-order-selection]');
  const summary = query('[data-order-map-summary]');
  let data = null;
  let mapMode = 'regions';
  let selectedVehicleId = 'V1';
  let selectedDeliveryId = null;
  let lastExternalSelectedId = null;
  let lastExternalVehicleId = null;
  let vehicleSignature = '';
  let markerSignature = '';
  let geometrySignature = '';
  let fitVehicleRequested = false;
  let visibleDeliveries = [];
  let routeData = null;
  let routeState = 'idle';
  let map = null;
  let mapMarkers = [];
  let resizeObserver = null;
  let wheelZoom = null;
  let destroyed = false;
  let mapFailure = '';
  let pointLayer = null;
  let sourcePoints = null;
  let sourceRegions = null;
  let sourceModel = null;
  let sourceData = null;
  let overlapIds = [];
  let listQuery = '';
  let listPage = 1;
  let pendingAssignment = null;
  let selectedZoneId = null;
  let zoneRows = { rows: [], totals: null, unlocated: null };
  let zonePage = 1;
  let zonePinCache = null;
  let zoneHtml = '';
  let zoneDriverMap = new Map();
  let popupHtml = '';
  let multiMode = false;
  let bulkSelection = new Set();
  let bulkNotice = '';
  let dragStart = null;
  const reassignDialog = query('[data-order-reassign-dialog]');
  const imported = () => Boolean(data?.dispatchSource);
  const canPin = () => Boolean(onAssign && imported() && (!data.dispatch || (!data.dispatch.readOnly && ['draft', 'amending'].includes(data.dispatch.phase))));
  const selectedAssignmentProtected = () => Boolean(visibleDeliveries.find(item => item.id === selectedDeliveryId)?.assignmentProtected);
  const pinVehicles = () => vehiclesFor(data).filter(vehicle => !data?.dispatch || data.dispatch.candidateIds.includes(vehicle.id));
  const setText = (selector, text) => { const node = query(selector); if (node) node.textContent = text; };
  const multiAvailable = () => canPin() && imported();
  const DRAG_THRESHOLD = 6;
  function syncBulk() {
    if (multiMode && !multiAvailable()) multiMode = false;
    const summary = summarizeSelection(bulkSelection, visibleDeliveries);
    const toggle = query('[data-order-multi-toggle]');
    if (toggle) { toggle.disabled = !multiAvailable(); toggle.setAttribute('aria-pressed', String(multiMode)); }
    const transfer = query('[data-order-multi-transfer]');
    if (transfer) transfer.disabled = !multiAvailable() || !summary.orderCount;
    const clearButton = query('[data-order-multi-clear]');
    if (clearButton) clearButton.disabled = !summary.orderCount;
    setText('[data-order-multi-summary]', summary.orderCount
      ? `선택 ${summary.destinationCount.toLocaleString('ko-KR')}곳 / ${summary.orderCount.toLocaleString('ko-KR')}건 / ${boxesText(summary.boxes)}${bulkNotice}`
      : multiMode ? `핀을 클릭하거나 지도를 드래그해 배송지를 고르세요. 지도를 옮기려면 복수 선택을 끄세요.${bulkNotice}`
        : multiAvailable() ? '복수 선택을 켜면 여러 배송지를 한 번에 이관할 수 있습니다.' : '');
    canvas.dataset.multiSelect = String(multiMode);
    map?.dragPan?.[multiMode ? 'disable' : 'enable']?.();
    map?.boxZoom?.[multiMode ? 'disable' : 'enable']?.();
  }
  function setMapMode(mode) {
    mapMode = mode;
    Array.from(element.querySelectorAll?.('[data-order-map-mode]') || []).forEach(input => { input.checked = input.value === mode; });
  }
  function changeBulk(result) {
    bulkSelection = result.selection;
    bulkNotice = result.skippedProtected ? ` (진행 및 완료 ${result.skippedProtected.toLocaleString('ko-KR')}곳은 제외)` : '';
    renderScene();
    renderOrderList();
  }
  function pickForBulk(orderIds) {
    if (orderIds.length) changeBulk(toggleUnits(bulkSelection, visibleDeliveries, orderIds));
  }
  const emptyPins = { type: 'FeatureCollection', features: [] };
  function zonePinsFor(zoneId) {
    if (!zoneId || !sourceModel) return emptyPins;
    if (zonePinCache?.model === sourceModel && zonePinCache.zoneId === zoneId) return zonePinCache.collection;
    const features = sourceModel.mapped.flatMap(({ delivery, coordinates }) => (delivery.zoneIds || []).includes(zoneId)
      ? [{ type: 'Feature', id: delivery.id, properties: { orderId: delivery.id, groupId: delivery.vehicleId, label: delivery.orderNumber }, geometry: { type: 'Point', coordinates } }] : []);
    zonePinCache = { model: sourceModel, zoneId, collection: { type: 'FeatureCollection', features } };
    return zonePinCache.collection;
  }
  function fitZone(zoneId) {
    const bounds = geometryBounds(sourceRegions?.features.find(feature => feature.properties?.zoneId === zoneId));
    if (bounds && map?.fitBounds) map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
  }
  function applyZone(zoneId, fit) {
    selectedZoneId = zoneId;
    selectedDeliveryId = null;
    overlapIds = [];
    if (zoneId) {
      if (mapMode !== 'regions') { multiMode = false; setMapMode('regions'); syncSourceLabels(); }
      const index = zoneRows.rows.findIndex(row => row.zoneId === zoneId);
      if (index >= 0) zonePage = Math.floor(index / PAGE_SIZE) + 1;
      if (fit) fitZone(zoneId);
    }
    renderScene();
    renderOrderList();
  }
  function pickZone(zoneId) {
    if (zoneId && zoneId === selectedZoneId) { selectedDeliveryId = null; overlapIds = []; renderScene(); return; }
    applyZone(zoneId, false);
  }
  function renderZonePanel() {
    const panel = query('[data-order-zone-panel]');
    if (!panel) return;
    panel.hidden = !imported();
    if (!imported()) {
      setText('[data-order-zone-total]', '');
      const emptyBody = query('[data-order-zone-rows]');
      if (emptyBody) emptyBody.innerHTML = '';
      zoneHtml = '';
      return;
    }
    const { rows, totals } = zoneRows;
    const paged = paginate(rows, zonePage);
    zonePage = paged.page;
    const volume = row => `${row.destinations.toLocaleString('ko-KR')}곳 / ${boxesText(row.boxes)} / 주문 ${row.orders.toLocaleString('ko-KR')}건 / 중량 ${weightText(row.weightKg)}`;
    setText('[data-order-zone-total]', totals ? `전체 ${volume(totals)}` : '');
    const body = query('[data-order-zone-rows]');
    const driverNames = new Map(vehiclesFor(data).map(vehicle => [vehicle.id, vehicle.driver || vehicle.id]));
    const html = paged.items.map(row => `<tr><th scope="row"><button type="button" data-order-zone-id="${escapeHtml(row.zoneId)}" aria-pressed="${row.zoneId === selectedZoneId}">${escapeHtml(row.label)}</button></th><td>${row.destinations.toLocaleString('ko-KR')}곳</td><td>${boxesText(row.boxes)}</td><td>${row.orders.toLocaleString('ko-KR')}건</td><td>${weightText(row.weightKg)}</td><td class="order-zone-drivers" title="${escapeHtml(driverNamesText(zoneDriverMap.get(row.zoneId), id => driverNames.get(id) || id, Infinity))}">${escapeHtml(driverNamesText(zoneDriverMap.get(row.zoneId), id => driverNames.get(id) || id))}</td></tr>`).join('');
    if (body && html !== zoneHtml) { zoneHtml = html; body.innerHTML = html; }
    setText('[data-order-zone-page]', `${paged.start}–${paged.end} / ${paged.total.toLocaleString('ko-KR')}곳`);
    const previous = query('[data-order-zone-previous]');
    const next = query('[data-order-zone-next]');
    if (previous) previous.disabled = paged.page === 1;
    if (next) next.disabled = paged.page === paged.pageCount;
  }
  function positionPopup() {
    const node = query('[data-order-popup]');
    const delivery = node && !node.hidden ? visibleDeliveries.find(item => item.id === selectedDeliveryId) : null;
    if (!delivery?.coordinates || !map?.project) return;
    const point = map.project(delivery.coordinates);
    const width = layer.clientWidth || 0;
    const above = point.y - 40 - (node.offsetHeight || 0) >= 0;
    node.dataset.placement = above ? 'above' : 'below';
    const half = (node.offsetWidth || 300) / 2 + 4;
    node.style.left = `${Math.round(width > half * 2 ? Math.min(Math.max(point.x, half), width - half) : point.x)}px`;
    node.style.top = `${Math.round(above ? point.y - 40 : point.y + 12)}px`;
  }
  // mousemove fires far more often than frames; keep only the latest point, write the DOM once per
  // frame, rewrite the content only when the zone changes, and move the box with a compositor transform.
  let hoverFrame = 0;
  let hoverNext = null;
  let hoverZoneId = null;
  function renderZoneHover(hovered) {
    hoverNext = hovered;
    if (!hoverFrame) hoverFrame = (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 16)))(paintZoneHover);
  }
  function paintZoneHover() {
    hoverFrame = 0;
    const hovered = hoverNext;
    const node = query('[data-order-zone-hover]');
    if (!node) return;
    const zone = hovered && mapMode === 'regions' ? zoneRows?.rows?.find(row => row.zoneId === hovered.zoneId) : null;
    if (!zone) { node.hidden = true; hoverZoneId = null; return; }
    if (zone.zoneId !== hoverZoneId || node.hidden) {
      const driverNames = new Map(vehiclesFor(data).map(vehicle => [vehicle.id, vehicle.driver || vehicle.id]));
      const drivers = driverNamesText(zoneDriverMap.get(zone.zoneId), id => driverNames.get(id) || id);
      node.innerHTML = `<strong>${escapeHtml(zone.label)}</strong>${volumeLines(zone).map(line => `<span>${escapeHtml(line)}</span>`).join('')}<small>주문 ${zone.orders.toLocaleString('ko-KR')}건 / ${escapeHtml(drivers)}</small>`;
      hoverZoneId = zone.zoneId;
      node.hidden = false;
    }
    const width = layer.clientWidth || 0;
    const height = layer.clientHeight || 0;
    const boxWidth = node.offsetWidth || 160;
    const boxHeight = node.offsetHeight || 90;
    const x = hovered.point.x + 14 + boxWidth <= width || !width ? hovered.point.x + 14 : hovered.point.x - 14 - boxWidth;
    const y = hovered.point.y + 14 + boxHeight <= height || !height ? hovered.point.y + 14 : hovered.point.y - 14 - boxHeight;
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }
  function renderPopup() {
    const node = query('[data-order-popup]');
    if (!node) return;
    const delivery = imported() && mapMode === 'regions' && selectedZoneId ? visibleDeliveries.find(item => item.id === selectedDeliveryId) : null;
    if (!delivery?.coordinates || !(delivery.zoneIds || []).includes(selectedZoneId)) { node.hidden = true; popupHtml = ''; return; }
    const unit = delivery.assignmentUnitId ? visibleDeliveries.filter(item => item.assignmentUnitId === delivery.assignmentUnitId) : [delivery];
    const weight = unit.every(item => Number.isFinite(item.weightKg) && item.weightKg >= 0) ? unit.reduce((sum, item) => sum + item.weightKg, 0) : null;
    const vehicle = vehiclesFor(data).find(item => item.id === delivery.vehicleId);
    const zone = zoneRows.rows.find(row => row.zoneId === selectedZoneId);
    const detail = [delivery.address, delivery.detailAddress].flatMap(part => part ? [escapeHtml(part)] : []).join(' ');
    const html = `<div class="order-popup-head"><strong>${escapeHtml(delivery.name || '배송지 미등록')}</strong><button type="button" class="order-dialog-close order-popup-close" data-order-popup-close aria-label="배송지 정보 닫기">${referenceIcon('close')}</button></div><p>${detail}</p><dl><dt>수량</dt><dd>주문 ${unit.length.toLocaleString('ko-KR')}건 / ${boxesText(totalBoxes(unit))}</dd><dt>중량</dt><dd>${weightText(weight)}</dd><dt>배송원</dt><dd>${escapeHtml(vehicle?.driver || '배차 대기')}</dd><dt>권역</dt><dd>${escapeHtml(zone?.label || delivery.regionName || '미확인')}</dd><dt>주문번호</dt><dd>${unit.map(item => escapeHtml(item.orderNumber)).join(', ')}</dd></dl><button type="button" class="button subtle" data-order-popup-pin ${canPin() && !delivery.assignmentProtected ? '' : 'disabled'}>핀배차</button> <button type="button" class="button subtle" data-order-popup-transfer ${canPin() && !delivery.assignmentProtected && transferOptionsFor(delivery).length ? '' : 'disabled'}>타 권역 이관</button>`;
    if (html !== popupHtml) { popupHtml = html; node.innerHTML = html; }
    node.hidden = false;
    positionPopup();
  }
  function syncSourceLabels() {
    const isSource = imported();
    const actions = query('[data-order-dispatch-actions]');
    if (actions) actions.hidden = !isSource;
    element.dataset.sourceKind = isSource ? 'file' : 'simulation';
    const modeControl = query('[data-order-map-mode-control]');
    if (modeControl) modeControl.hidden = !isSource;
    setText('[data-order-group-heading]', isSource ? data?.dispatch?.phase === 'unplanned' ? '후보 배송원' : '차량별 배정' : '배차 차량');
    setText('[data-order-group-note]', isSource ? '주문 수신 순서' : '수신 순서');
    const listPanel = query('[data-order-list-panel]');
    if (listPanel) listPanel.hidden = !isSource;
  }
  function syncSummary() {
    const source = deliveriesFor(data);
    const boxes = totalBoxes(source);
    summary.innerHTML = imported()
      ? `<span>주문 ${(source?.length || 0).toLocaleString('ko-KR')}건</span><span>총 ${boxesText(boxes)}</span>`
      : `<span>총 ${boxesText(boxes)}</span><span>차량 ${vehiclesFor(data).length}대</span>`;
  }

  function syncDispatchActions() {
    const pinButton = query('[data-order-dispatch-pin]');
    if (!pinButton) return;
    pinButton.disabled = !canPin() || !selectedDeliveryId || selectedAssignmentProtected();
    setText('[data-order-dispatch-context]', data?.dispatch?.readOnly ? '과거 배차는 조회만 가능합니다.'
      : data?.dispatch?.phase === 'unplanned' ? '배송원을 선택한 뒤 배차 계산을 진행해 주세요.'
        : data?.dispatch?.phase === 'published' ? '확정된 배차입니다. 배차 수정을 시작한 뒤 변경할 수 있습니다.'
          : selectedAssignmentProtected() ? '현재 진행 중이거나 완료된 배송지 묶음은 배차를 변경할 수 없습니다.'
          : data?.dispatch?.phase === 'amending' ? '지도에서 배송지를 선택해 수정하고 변경 배차를 다시 전송해 주세요.'
            : '지도에서 배송지를 선택해 계산안의 배정을 수정합니다.');
  }

  function updateAssignmentPreview() {
    if (!pendingAssignment) return;
    const targetId = query('[data-order-reassign-target]').value;
    const vehicle = vehiclesFor(data).find(item => item.id === targetId);
    const confirm = query('[data-order-reassign-confirm]');
    const bulk = pendingAssignment.bulk
      ? transferPreview(visibleDeliveries.filter(item => pendingAssignment.orderIds.includes(item.id)), targetId) : null;
    confirm.disabled = !vehicle || targetId === pendingAssignment.fromGroupId || (bulk !== null && bulk.movingCount === 0);
    if (confirm.disabled) {
      setText('[data-order-reassign-preview]', vehicle && bulk && !bulk.movingCount ? '선택한 배송지는 이미 이 차량에 배정되어 있습니다.'
        : pendingAssignment.zoneOptions ? '대상 권역과 그 권역의 배송원을 선택해 주세요.' : '배정할 다른 차량을 선택해 주세요.');
      return;
    }
    const currentOrders = visibleDeliveries.filter(item => item.vehicleId === targetId);
    const currentBoxes = totalBoxes(currentOrders);
    const coordinates = vehicle.location?.coordinates;
    const position = coordinates && !isUnverifiedVehicle(vehicle) ? ` (${coordinates[1].toFixed(4)}, ${coordinates[0].toFixed(4)})` : '';
    const movingBoxes = bulk ? bulk.boxes : pendingAssignment.boxes;
    const movingCount = bulk ? bulk.movingCount : pendingAssignment.orderIds.length;
    const nextBoxes = currentBoxes === null || movingBoxes === null ? null : currentBoxes + movingBoxes;
    const targetZone = pendingAssignment.zoneOptions?.find(option => option.zoneId === query('[data-order-reassign-zone]')?.value);
    const zoneLine = targetZone ? `\n대상 권역 ${targetZone.label} (배송지의 위치와 권역 소속은 그대로입니다)` : '';
    const movingLine = bulk ? `\n이동 ${bulk.movingCount}건 / ${boxesText(bulk.boxes)}${bulk.unchangedCount ? ` (이미 이 차량 ${bulk.unchangedCount}건 제외)` : ''}` : '';
    setText('[data-order-reassign-preview]', `대상 차량 ${vehicle.driver} / ${plateLabel(vehicle)}\n현재 ${currentOrders.length}건 / ${boxesText(currentBoxes)} → 배차 후 ${currentOrders.length + movingCount}건 / ${boxesText(nextBoxes)}${movingLine}${zoneLine}\n${locationLabel(vehicle)}${position}`);
  }

  function resetZoneTransferControls() {
    const label = query('[data-order-reassign-zone-label]');
    if (label) label.hidden = true;
    const target = query('[data-order-reassign-target]');
    if (target) target.disabled = false;
  }
  function transferOptionsFor(delivery) {
    if (!delivery?.vehicleId || !selectedZoneId) return [];
    return transferZoneOptions(zoneRows.rows, zoneDriverMap, pinVehicles().map(vehicle => vehicle.id), { fromZoneId: selectedZoneId, fromVehicleId: delivery.vehicleId });
  }
  function openZoneTransfer() {
    if (!canPin() || selectedAssignmentProtected() || !selectedZoneId) return;
    const chosen = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    const options = transferOptionsFor(chosen);
    if (!chosen || !options.length) return;
    const selected = chosen.assignmentUnitId ? visibleDeliveries.filter(item => item.assignmentUnitId === chosen.assignmentUnitId) : [chosen];
    const from = vehiclesFor(data).find(item => item.id === chosen.vehicleId);
    const fromZone = zoneRows.rows.find(row => row.zoneId === selectedZoneId)?.label || selectedZoneId;
    pendingAssignment = { date: data.dispatchSource.date, fromGroupId: chosen.vehicleId, orderIds: selected.map(item => item.id), boxes: totalBoxes(selected), zoneOptions: options };
    setText('[data-order-reassign-title]', '타 권역 이관');
    setText('[data-order-reassign-from]', `${chosen.name} / ${selected.length}건 / ${boxesText(pendingAssignment.boxes)} / ${fromZone} / ${from?.driver || '배차 대기'}`);
    const zoneSelect = query('[data-order-reassign-zone]');
    zoneSelect.innerHTML = '<option value="">권역을 선택해 주세요</option>' + options.map(option => `<option value="${escapeHtml(option.zoneId)}">${escapeHtml(option.label)} / 배송원 ${option.loads.length}명</option>`).join('');
    zoneSelect.value = '';
    query('[data-order-reassign-zone-label]').hidden = false;
    const select = query('[data-order-reassign-target]');
    select.innerHTML = '<option value="">권역을 먼저 선택해 주세요</option>';
    select.value = '';
    select.disabled = true;
    query('[data-order-reassign-error]').hidden = true;
    updateAssignmentPreview();
    reassignDialog.showModal();
  }
  function chooseTransferZone() {
    const option = pendingAssignment?.zoneOptions?.find(item => item.zoneId === query('[data-order-reassign-zone]').value);
    const select = query('[data-order-reassign-target]');
    select.disabled = !option;
    select.innerHTML = option ? option.loads.map(load => {
      const vehicle = vehiclesFor(data).find(item => item.id === load.vehicleId);
      return `<option value="${escapeHtml(load.vehicleId)}">${escapeHtml(vehicle?.driver || load.vehicleId)} / ${escapeHtml(plateLabel(vehicle))} / 이 권역 ${load.destinations.toLocaleString('ko-KR')}곳 ${boxesText(load.boxes)}</option>`;
    }).join('') : '<option value="">권역을 먼저 선택해 주세요</option>';
    select.value = option ? option.loads[0].vehicleId : '';
    updateAssignmentPreview();
  }

  function openBulkAssignment() {
    if (!canPin()) return;
    const summary = summarizeSelection(bulkSelection, visibleDeliveries);
    if (!summary.orderCount) return;
    const drivers = [...new Set(summary.deliveries.map(item => vehiclesFor(data).find(vehicle => vehicle.id === item.vehicleId)?.driver || '배차 대기'))];
    const driverText = drivers.length > 3 ? `${drivers.slice(0, 3).join(', ')} 외 ${drivers.length - 3}명` : drivers.join(', ');
    resetZoneTransferControls();
    pendingAssignment = { date: data.dispatchSource.date, fromGroupId: null, bulk: true, orderIds: summary.orderIds, boxes: summary.boxes };
    setText('[data-order-reassign-title]', '선택 이관');
    setText('[data-order-reassign-from]', `선택 ${summary.destinationCount.toLocaleString('ko-KR')}곳 / ${summary.orderCount.toLocaleString('ko-KR')}건 / ${boxesText(summary.boxes)} / 현재 배정: ${driverText}`);
    const select = query('[data-order-reassign-target]');
    select.innerHTML = '<option value="">차량을 선택해 주세요</option>' + pinVehicles().map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.driver)} / ${escapeHtml(plateLabel(vehicle))}</option>`).join('');
    select.value = '';
    query('[data-order-reassign-error]').hidden = true;
    updateAssignmentPreview();
    reassignDialog.showModal();
  }

  function openAssignment() {
    if (!canPin() || selectedAssignmentProtected()) return;
    const chosen = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!chosen) return;
    const selected = chosen.assignmentUnitId ? visibleDeliveries.filter(item => item.assignmentUnitId === chosen.assignmentUnitId) : [chosen];
    const fromGroupId = chosen.vehicleId;
    const from = vehiclesFor(data).find(item => item.id === fromGroupId);
    resetZoneTransferControls();
    pendingAssignment = { date: data.dispatchSource.date, fromGroupId, orderIds: selected.map(item => item.id), boxes: totalBoxes(selected) };
    setText('[data-order-reassign-title]', '핀배차');
    setText('[data-order-reassign-from]', `${chosen.name} / ${selected.length}건 / ${boxesText(pendingAssignment.boxes)} / ${from?.driver || '배차 대기'}`);
    const select = query('[data-order-reassign-target]');
    select.innerHTML = '<option value="">차량을 선택해 주세요</option>' + pinVehicles().filter(vehicle => vehicle.id !== fromGroupId).map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.driver)} / ${escapeHtml(plateLabel(vehicle))}</option>`).join('');
    select.value = '';
    query('[data-order-reassign-error]').hidden = true;
    updateAssignmentPreview();
    reassignDialog.showModal();
  }

  async function applyAssignment() {
    if (!canPin() || !pendingAssignment || pendingAssignment.date !== data?.dispatchSource?.date) return;
    const targetId = query('[data-order-reassign-target]').value;
    if (!targetId || targetId === pendingAssignment.fromGroupId) return;
    const confirm = query('[data-order-reassign-confirm]');
    if (confirm.disabled) return;
    confirm.disabled = true;
    const request = pendingAssignment;
    try {
      const result = await onAssign({ orderIds: request.orderIds, targetGroupId: targetId });
      if (request !== pendingAssignment || request.date !== data?.dispatchSource?.date) return;
      selectedVehicleId = targetId;
      if (request.bulk) { bulkSelection = new Set(); bulkNotice = ''; }
      updateVehicles(); renderScene(); renderOrderList();
      reassignDialog.close();
      const status = query('[data-order-dispatch-result]');
      status.textContent = `배차 변경: ${result.changedCount}건 / ${boxesText(result.changedBoxes)}. ${data?.dispatch?.phase === 'amending' ? '수정안에 반영했습니다. 변경 배차를 다시 전송하면 확정됩니다.' : '배차 계산안에 반영했습니다. 전체 배차 전송 시 확정됩니다.'}`;
      status.hidden = false;
    } catch (error) {
      const status = query('[data-order-reassign-error]');
      status.textContent = error.message || '배정을 변경하지 못했습니다.'; status.hidden = false;
    } finally { confirm.disabled = false; }
  }

  function updateSelection() {
    syncDispatchActions();
    syncBulk();
    selection.hidden = imported() && mapMode === 'regions';
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) { selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>'; return; }
    const fallbackVehicleId = visibleDeliveries === data?.deliveries ? data?.vehicle?.id : null;
    const deliveryVehicleId = vehicleIdFor(delivery, fallbackVehicleId);
    const vehicle = vehiclesFor(data).find(item => item.id === deliveryVehicleId) ?? delivery.vehicle ?? null;
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || '배송지 미등록')}</strong><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle ? plateLabel(vehicle) : '차량 미확인')}</span></p>`;
    if (imported()) {
      selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name)}</strong><p>${escapeHtml(delivery.address)}</p><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.driver || '배차 대기')}</span><span>권역 ${escapeHtml(delivery.regionName)}</span></p>`;
      if (overlapIds.length > 1) selection.innerHTML += `<label class="order-overlap-picker">이 지점의 주문 ${overlapIds.length}건<select data-order-overlap aria-label="겹친 주문 선택">${overlapIds.map(id => visibleDeliveries.find(item => item.id === id)).filter(Boolean).map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selectedDeliveryId ? 'selected' : ''}>${escapeHtml(item.name)} / ${boxesText(item.boxes)}</option>`).join('')}</select></label>`;
      selection.innerHTML += `<button type="button" class="button subtle order-pin-action" data-order-pin-selected ${canPin() && !delivery.assignmentProtected ? '' : 'disabled'}>핀배차</button>`;
    }
  }

  function renderOrderList() {
    if (!imported()) return;
    const needle = listQuery.trim().toLocaleLowerCase('ko-KR');
    const source = deliveriesFor(data);
    const matches = needle ? source.filter(item => `${item.orderNumber} ${item.name} ${item.address} ${item.driver}`.toLocaleLowerCase('ko-KR').includes(needle)) : source;
    const paged = paginate(matches, listPage);
    listPage = paged.page;
    const list = query('[data-order-list]');
    if (!list) return;
    list.innerHTML = paged.items.map(item => `<button type="button" data-order-list-id="${escapeHtml(item.id)}" aria-pressed="${multiMode ? bulkSelection.has(item.id) : item.id === selectedDeliveryId}"><strong>${escapeHtml(item.orderNumber)}</strong><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.driver)}</span><b>${boxesText(item.boxes)}</b></button>`).join('') || '<p>일치하는 주문이 없습니다.</p>';
    setText('[data-order-list-total]', `${source.length.toLocaleString('ko-KR')}건`);
    setText('[data-order-page]', `${paged.start}–${paged.end} / ${paged.total.toLocaleString('ko-KR')}건`);
    query('[data-order-previous]').disabled = paged.page === 1;
    query('[data-order-next]').disabled = paged.page === paged.pageCount;
  }

  function pickSourceOrder(id) {
    selectedDeliveryId = id;
    renderScene();
    renderOrderList();
    onSelect(id);
  }

  function renderScene() {
    const source = deliveriesFor(data) || [];
    const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
    const vehicleDeliveries = source.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === selectedVehicleId);
    visibleDeliveries = source;
    if (!visibleDeliveries.some(delivery => delivery.id === selectedDeliveryId)) selectedDeliveryId = null;
    if (mapFailure || routeState !== 'ready') {
      count.textContent = mapFailure ? '지도 사용 불가' : routeState === 'failed' ? '위치 데이터 미확인' : '위치 데이터 확인 중';
      mapStatus.hidden = false;
      mapStatusText.textContent = mapFailure || (routeState === 'failed' ? '배송지 위치 데이터를 불러오지 못했습니다.' : '배송지 위치를 불러오고 있습니다.');
      mapRetry.hidden = !mapFailure && routeState !== 'failed';
      updateSelection();
      syncSummary();
      return;
    }
    const model = imported() ? sourceModel : orderMapModel(source, routeData);
    const selectedModel = orderMapModel(vehicleDeliveries, routeData);
    const nextMarkerSignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${delivery.name}:${delivery.boxes}:${delivery.sequence}:${vehicleIdFor(delivery, fallbackVehicleId)}:${coordinates}`).join('|');
    const nextGeometrySignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${coordinates}`).join('|');
    if (map && imported()) {
      const zones = selectedZoneId ? [selectedZoneId] : selectedDeliveryId
        ? source.find(item => item.id === selectedDeliveryId)?.zoneIds || []
        : selectedVehicleId === 'all' ? [] : [...new Set(vehicleDeliveries.flatMap(item => item.zoneIds || []))];
      pointLayer.update({ points: sourcePoints, regions: sourceRegions, selectedGroupId: selectedVehicleId === 'all' ? null : selectedVehicleId, selectedOrderId: selectedDeliveryId, selectedOrderIds: [...bulkSelection], selectedZoneIds: zones, zonePins: zonePinsFor(selectedZoneId), mode: mapMode });
      if (mapFailure) return;
    } else if (map && nextMarkerSignature !== markerSignature) {
      markerSignature = nextMarkerSignature;
      mapMarkers.splice(0).forEach(marker => marker.remove());
      mapMarkers = model.mapped.map(({ delivery, coordinates }) => ({ ...markerFactory(map, delivery, coordinates), delivery }));
    }
    mapMarkers.forEach(marker => {
      marker.element.setAttribute('data-selected-vehicle', String(vehicleIdFor(marker.delivery, fallbackVehicleId) === selectedVehicleId));
      marker.element.setAttribute('aria-pressed', String(marker.element.dataset.orderMarker === selectedDeliveryId));
    });
    if (map && (fitVehicleRequested || nextGeometrySignature !== geometrySignature)) {
      geometrySignature = nextGeometrySignature;
      const fitModel = fitVehicleRequested && selectedVehicleId !== 'all' ? selectedModel : model;
      const coordinates = fitModel.mapped.map(item => item.coordinates);
      fitVehicleRequested = false;
      if (coordinates.length === 1) map.jumpTo({ center: coordinates[0], zoom: 15 });
      if (coordinates.length > 1) {
        const lngs = coordinates.map(point => point[0]);
        const lats = coordinates.map(point => point[1]);
        map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: { top: 72, bottom: 92, left: 48, right: 48 }, maxZoom: 15, duration: 0 });
      }
    }
    count.textContent = `지도 ${model.mapped.length.toLocaleString('ko-KR')}곳 / 전체 위치 미등록 ${model.unknownCount.toLocaleString('ko-KR')}곳 / 선택 차량 미등록 ${selectedModel.unknownCount.toLocaleString('ko-KR')}곳`;
    if (imported()) count.textContent = `전체 주문 ${source.length.toLocaleString('ko-KR')}건 / 위치 등록 ${model.mapped.length.toLocaleString('ko-KR')}건 / 위치 미등록 ${model.unknownCount.toLocaleString('ko-KR')}건 / 주문이 있는 권역 ${sourceRegions?.features.filter(feature => feature.properties.orderCount > 0).length.toLocaleString('ko-KR') || '0'}구역. 겹친 위치의 주문도 그대로 포함합니다.`;
    canvas.dataset.orderPointCount = String(model.mapped.length);
    canvas.dataset.orderDate = data?.dispatchSource?.date || '';
    mapStatus.hidden = true;
    mapRetry.hidden = true;
    mapStatusText.textContent = '';
    updateSelection();
    renderPopup();
    renderZonePanel();
    syncSummary();
  }

  function ensureMap() {
    if (!map) {
      try {
        map = mapFactory(layer);
        wheelZoom = installModifierWheelZoom(map);
        mapFailure = '';
        map.on?.('move', positionPopup);
        resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => map?.resize()) : null;
        resizeObserver?.observe(canvas);
      } catch {
        mapFailure = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
        mapStatus.hidden = false;
        mapStatusText.textContent = mapFailure;
        return;
      }
    }
    map.resize?.();
    if (imported()) {
      if (!pointLayer) pointLayer = layerFactory(map, { onZonePick: pickZone, onZoneHover: renderZoneHover, onPick(ids) { if (multiMode && multiAvailable()) { pickForBulk(ids); return; } overlapIds = ids; selectedDeliveryId = ids[0] || null; if (!selectedDeliveryId) { selectedVehicleId = 'all'; fitVehicleRequested = false; updateVehicles(); } renderScene(); renderOrderList(); if (selectedDeliveryId) onSelect(selectedDeliveryId); }, onError(error) { mapFailure = error?.message || '주문 지도 레이어를 불러오지 못했습니다.'; renderScene(); } });
      if (sourceData !== data) {
        sourceData = data;
        mapMarkers.splice(0).forEach(marker => marker.remove());
        routeData = { points: deliveriesFor(data).filter(item => item.coordinates).map(item => ({ id: item.id, lng: item.coordinates[0], lat: item.coordinates[1] })) };
        sourceModel = orderMapModel(deliveriesFor(data), routeData);
        sourcePoints = { type: 'FeatureCollection', features: sourceModel.mapped.map(({ delivery, coordinates }) => ({ type: 'Feature', id: delivery.id, properties: { orderId: delivery.id, groupId: delivery.vehicleId, label: delivery.orderNumber }, geometry: { type: 'Point', coordinates } })) };
        zoneRows = zoneVolumes(data.dispatchRegions, deliveriesFor(data));
        zoneDriverMap = zoneDrivers(deliveriesFor(data));
        sourceRegions = withZoneVolumes(regionOrderCounts(data.dispatchRegions, deliveriesFor(data)), zoneRows.rows);
        if (selectedZoneId && !zoneRows.rows.some(row => row.zoneId === selectedZoneId)) selectedZoneId = null;
      }
      routeState = 'ready';
      return;
    }
    if (routeState !== 'idle') return;
    if (typeof loadRouteData !== 'function') {
      routeData = { points: [] };
      routeState = 'ready';
      return;
    }
    routeState = 'loading';
    Promise.resolve().then(loadRouteData).then(value => {
      if (destroyed) return;
      if (!value || !Array.isArray(value.points)) throw new TypeError('route data unavailable');
      routeData = value;
      routeState = 'ready';
      markerSignature = '';
      geometrySignature = '';
      renderScene();
    }).catch(() => {
      if (destroyed) return;
      routeState = 'failed';
      renderScene();
    });
  }

  function updateVehicles() {
    const vehicles = planningVehicles(data);
    const rows = planningOperations(data);
    const rowsByVehicle = new Map(rows.map(row => [row.vehicle.id, row]));
    if (!vehicles.some(vehicle => vehicle.id === selectedVehicleId) && !(imported() && selectedVehicleId === 'all')) selectedVehicleId = imported() ? 'all' : vehicles.find(vehicle => vehicle.id === 'V1')?.id ?? vehicles[0]?.id ?? '';
    const source = deliveriesFor(data) || [];
    const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
    const nextSignature = `${data?.dispatch?.phase || ''}|${selectedVehicleId}|${data?.kpi?.finishEta || ''}|${vehicles.map(vehicle => { const timing = rowsByVehicle.get(vehicle.id)?.timing; return `${vehicle.id}:${vehicle.plate}:${vehicle.driver}:${vehicle.departure?.time || ''}:${vehicle.departure?.source || ''}:${timing?.completionMs ?? ''}:${timing?.completed ?? ''}:${timing?.heldStops ?? ''}`; }).join('|')}|${source.map(delivery => `${delivery.id}:${vehicleIdFor(delivery, fallbackVehicleId)}:${delivery.boxes}`).join('|')}`;
    if (nextSignature === vehicleSignature) return;
    vehicleSignature = nextSignature;
    const focusedVehicleId = typeof document === 'object' && vehicleSelect.contains?.(document.activeElement) ? document.activeElement?.dataset?.orderVehicleId : null;
    vehicleSelect.innerHTML = vehicles.map(vehicle => {
      const assigned = source.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === vehicle.id);
      const boxes = totalBoxes(assigned);
      const departureLabel = vehicle.departure?.source === 'scenario-baseline' ? '고정 출발 (시나리오 기준)' : '고정 출발';
      const row = rowsByVehicle.get(vehicle.id);
      const departure = escapeHtml(row?.fixedDepartureText || vehicle.departure?.time || '미등록');
      const lastArrival = row?.lastArrivalEta || (vehicle.live && (data?.kpi?.finishEta || '').endsWith('완료') ? 'ETA 미해당' : '미등록');
      const held = row?.timing?.heldStops || 0;
      const completion = held ? `보류 ${countText(held)}, 미확인`
        : Number.isFinite(row?.timing?.completionMs) ? `${clockText(row.timing.completionMs, data?.dispatchSource?.date)}${row.timing.completed ? ' 완료' : ' 예상'}` : '미등록';
      const completionLabel = row?.timing?.completed ? '최종 인도 완료' : '최종 인도 완료 예측';
      const regionLabel = `${vehicle.region || '권역 미등록'} / ${locationLabel(vehicle)}`;
      if (imported()) return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong title="${escapeHtml(vehicle.driver)}">${escapeHtml(vehicle.driver)}</strong><small>${escapeHtml(plateLabel(vehicle))}</small></span><span class="order-vehicle-load"><b>${data?.dispatch?.phase === 'unplanned' ? '배차 대기' : `${countText(bundleDeliveries(assigned).length)} / 주문 ${assigned.length.toLocaleString('ko-KR')}건`}</b><b>${boxesText(boxes)}</b></span><span class="order-source-regions" title="${escapeHtml(regionLabel)}">${escapeHtml(regionLabel)}</span></button>`;
      return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong>${escapeHtml(vehicle.plate || vehicle.id)}</strong><small>${escapeHtml(vehicle.driver || '배송원 미확인')}</small></span><span class="order-vehicle-load"><b>${countText(assigned.length)}</b><b>${boxesText(boxes)}</b></span><span class="order-vehicle-times"><span>${departureLabel} <strong>${departure}</strong></span><span>마지막 도착 ETA <strong>${escapeHtml(lastArrival)}</strong></span><span>${completionLabel} <strong>${escapeHtml(completion)}</strong></span></span></button>`;
    }).join('') || '<p class="order-vehicle-empty">배차 차량이 없습니다.</p>';
    if (imported()) vehicleSelect.innerHTML = `<button type="button" data-order-vehicle-id="all" aria-pressed="${selectedVehicleId === 'all'}"><span class="order-vehicle-name"><strong>${data?.dispatch?.phase === 'unplanned' ? '전체 주문' : '전체 차량'}</strong><small>${vehicles.length}대</small></span><span class="order-vehicle-load"><b>주문 ${source.length.toLocaleString('ko-KR')}건</b><b>${boxesText(totalBoxes(source))}</b></span></button>` + vehicleSelect.innerHTML;
    if (focusedVehicleId) Array.from(vehicleSelect.querySelectorAll?.('[data-order-vehicle-id]') || []).find(item => item.dataset.orderVehicleId === focusedVehicleId)?.focus();
  }

  const listeners = [];
  const listen = (node, type, listener) => { if (!node) return; node.addEventListener(type, listener); listeners.push(() => node.removeEventListener(type, listener)); };
  listen(mapRetry, 'click', () => {
    if (mapFailure) {
      pointLayer?.destroy(); pointLayer = null; mapFailure = '';
      ensureMap(); renderScene();
      return;
    }
    if (routeState !== 'failed') return;
    routeState = 'idle';
    ensureMap();
    renderScene();
  });
  listen(vehicleSelect, 'click', event => {
    const vehicle = event.target.closest?.('[data-order-vehicle-id]');
    if (!vehicle) return;
    fitVehicleRequested = vehicle.dataset.orderVehicleId === selectedVehicleId;
    selectedVehicleId = vehicle.dataset.orderVehicleId;
    selectedDeliveryId = null;
    overlapIds = [];
    updateVehicles();
    renderScene();
  });
  listen(canvas, 'click', event => { const marker = event.target.closest('[data-order-marker]'); if (!marker) return; selectedDeliveryId = marker.dataset.orderMarker; renderScene(); onSelect(selectedDeliveryId); });
  listen(query('[data-order-map-mode-control]'), 'change', event => {
    if (!event.target.matches?.('[data-order-map-mode]')) return;
    if (!['regions', 'orders'].includes(event.target.value)) return;
    mapMode = event.target.value;
    if (mapMode === 'regions') { selectedDeliveryId = null; overlapIds = []; multiMode = false; }
    syncSourceLabels();
    renderScene();
  });
  listen(selection, 'change', event => { if (event.target.matches?.('[data-order-overlap]')) pickSourceOrder(event.target.value); });
  listen(selection, 'click', event => { if (event.target.closest?.('[data-order-pin-selected]')) openAssignment('pin'); });
  listen(query('[data-order-dispatch-pin]'), 'click', () => openAssignment('pin'));
  listen(query('[data-order-reassign-target]'), 'change', updateAssignmentPreview);
  listen(query('[data-order-reassign-zone]'), 'change', chooseTransferZone);
  listen(query('[data-order-reassign-confirm]'), 'click', applyAssignment);
  listen(query('[data-order-reassign-cancel]'), 'click', () => reassignDialog.close());
  listen(query('[data-order-reassign-close]'), 'click', () => reassignDialog.close());
  listen(reassignDialog, 'close', () => { pendingAssignment = null; resetZoneTransferControls(); query('[data-order-dispatch-pin]')?.focus(); });
  listen(query('[data-order-zone-rows]'), 'click', event => {
    const row = event.target.closest?.('[data-order-zone-id]');
    if (!row) return;
    applyZone(row.dataset.orderZoneId === selectedZoneId ? null : row.dataset.orderZoneId, true);
  });
  listen(query('[data-order-zone-previous]'), 'click', () => { zonePage -= 1; renderZonePanel(); });
  listen(query('[data-order-zone-next]'), 'click', () => { zonePage += 1; renderZonePanel(); });
  listen(query('[data-order-popup]'), 'click', event => {
    if (event.target.closest?.('[data-order-popup-close]')) { selectedDeliveryId = null; overlapIds = []; renderScene(); renderOrderList(); return; }
    if (event.target.closest?.('[data-order-popup-pin]')) openAssignment('pin');
    if (event.target.closest?.('[data-order-popup-transfer]')) openZoneTransfer();
  });
  listen(query('[data-order-multi-toggle]'), 'click', () => {
    if (!multiAvailable()) return;
    multiMode = !multiMode;
    bulkNotice = '';
    if (multiMode) setMapMode('orders');
    syncSourceLabels();
    renderScene();
    renderOrderList();
  });
  listen(query('[data-order-multi-transfer]'), 'click', openBulkAssignment);
  listen(query('[data-order-multi-clear]'), 'click', () => { changeBulk({ selection: new Set(), skippedProtected: 0 }); });
  const selectBox = query('[data-order-select-box]');
  const pointerPosition = event => { const bounds = layer.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; };
  // While dragging, the pointer may end over a map overlay or outside the map, so the document receives the events.
  const dragHost = () => globalThis.document ?? layer;
  function stopDrag() {
    const host = dragHost();
    host.removeEventListener('pointermove', moveDrag);
    host.removeEventListener('pointerup', endDrag);
    host.removeEventListener('pointercancel', cancelDrag);
    dragStart = null;
    if (selectBox) selectBox.hidden = true;
  }
  function moveDrag(event) {
    if (!dragStart) return;
    const current = pointerPosition(event);
    if (!dragStart.moved && Math.hypot(current.x - dragStart.x, current.y - dragStart.y) < DRAG_THRESHOLD) return;
    dragStart.moved = true;
    if (!selectBox) return;
    selectBox.hidden = false;
    Object.assign(selectBox.style, { left: `${Math.min(dragStart.x, current.x)}px`, top: `${Math.min(dragStart.y, current.y)}px`, width: `${Math.abs(current.x - dragStart.x)}px`, height: `${Math.abs(current.y - dragStart.y)}px` });
  }
  function endDrag(event) {
    if (!dragStart) return;
    const start = dragStart;
    const end = pointerPosition(event);
    stopDrag();
    if (!start.moved && Math.hypot(end.x - start.x, end.y - start.y) < DRAG_THRESHOLD) return;
    if (!map || !sourceModel) return;
    const points = sourceModel.mapped.map(({ delivery, coordinates }) => { const point = map.project(coordinates); return { id: delivery.id, x: point.x, y: point.y }; });
    const ids = pointsInRectangle(points, start, end);
    if (ids.length) changeBulk(addUnits(bulkSelection, visibleDeliveries, ids));
  }
  function cancelDrag() { stopDrag(); }
  listen(layer, 'pointerdown', event => {
    if (!multiMode || !multiAvailable() || !map || event.button !== 0 || event.isPrimary === false) return;
    if (dragStart) stopDrag();
    dragStart = { ...pointerPosition(event), moved: false };
    const host = dragHost();
    host.addEventListener('pointermove', moveDrag);
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', cancelDrag);
  });
  listen(query('[data-order-search]'), 'input', event => { listQuery = event.target.value; listPage = 1; renderOrderList(); });
  listen(query('[data-order-list]'), 'click', event => {
    const item = event.target.closest('[data-order-list-id]');
    if (!item) return;
    if (multiMode && multiAvailable()) { pickForBulk([item.dataset.orderListId]); return; }
    overlapIds = [];
    pickSourceOrder(item.dataset.orderListId);
    const delivery = visibleDeliveries.find(row => row.id === selectedDeliveryId);
    if (delivery?.coordinates) map?.easeTo?.({ center: delivery.coordinates, zoom: Math.max(map.getZoom(), 13), duration: 0 });
    canvas.scrollIntoView?.({ block: 'nearest' });
  });
  listen(query('[data-order-previous]'), 'click', () => { listPage--; renderOrderList(); });
  listen(query('[data-order-next]'), 'click', () => { listPage++; renderOrderList(); });

  syncSummary();
  return {
    clear({ empty = false, message = '주문 자료를 확인하고 있습니다.' } = {}) {
      data = null;
      reassignDialog.close();
      resizeObserver?.disconnect(); resizeObserver = null;
      mapMarkers.splice(0).forEach(marker => marker.remove());
      wheelZoom?.remove(); wheelZoom = null;
      pointLayer?.destroy(); pointLayer = null;
      map?.remove?.(); map = null;
      sourceData = null; routeData = null; routeState = 'idle'; mapFailure = '';
      vehicleSignature = ''; markerSignature = ''; geometrySignature = '';
      selectedDeliveryId = null; visibleDeliveries = []; overlapIds = []; listQuery = ''; listPage = 1;
      multiMode = false; bulkSelection = new Set(); bulkNotice = '';
      selectedZoneId = null; zoneRows = { rows: [], totals: null, unlocated: null }; zoneDriverMap = new Map(); zonePage = 1; zonePinCache = null;
      if (dragStart) stopDrag();
      element.dataset.sourceKind = 'unavailable';
      setText('[data-order-group-heading]', '후보 배송원');
      setText('[data-order-group-note]', empty ? '0명' : '자료 확인 전');
      vehicleSelect.innerHTML = `<p class="order-vehicle-empty">${empty ? '미등록' : '미확인'}</p>`;
      query('[data-order-dispatch-actions]').hidden = false;
      query('[data-order-dispatch-pin]').disabled = true;
      setText('[data-order-dispatch-context]', '주문과 계산안 준비 전');
      query('[data-order-dispatch-result]').hidden = true;
      query('[data-order-map-mode-control]').hidden = false;
      query('[data-order-map-mode-control]').querySelectorAll('input').forEach(input => { input.disabled = true; });
      mapStatus.hidden = empty; mapRetry.hidden = true; mapStatusText.textContent = empty ? '' : message;
      count.textContent = empty ? '위치 미등록' : '위치 미확인';
      selection.hidden = true;
      selection.innerHTML = '';
      summary.textContent = empty ? '주문 0건 / 총 0박스' : '주문 수량 확인 전';
      delete canvas.dataset.orderPointCount; delete canvas.dataset.orderDate;
      const listPanel = query('[data-order-list-panel]');
      listPanel.hidden = false; listPanel.open = true;
      query('[data-order-search]').value = ''; query('[data-order-search]').disabled = true;
      setText('[data-order-list-total]', empty ? '0건' : '확인 전');
      query('[data-order-list]').innerHTML = `<p class="order-vehicle-empty">${empty ? '미등록' : '미확인'}</p>`;
      setText('[data-order-page]', empty ? '0건' : '확인 전');
      query('[data-order-previous]').disabled = true; query('[data-order-next]').disabled = true;
      syncBulk();
      renderZonePanel();
      renderPopup();
    },
    update(nextData, nextSelectedId) {
      if (element.dataset.sourceKind === 'unavailable') query('[data-order-list-panel]').open = false;
      query('[data-order-search]').disabled = false;
      query('[data-order-map-mode-control]').querySelectorAll('input').forEach(input => { input.disabled = false; });
      const dateChanged = data?.dispatchSource?.date !== nextData?.dispatchSource?.date;
      data = nextData || null;
      if (dateChanged) {
        reassignDialog?.close();
        const result = query('[data-order-dispatch-result]');
        if (result) result.hidden = true;
        if (mapFailure) { pointLayer?.destroy(); pointLayer = null; }
        selectedVehicleId = imported() ? 'all' : 'V1'; selectedDeliveryId = null; overlapIds = []; listPage = 1;
        multiMode = false; bulkSelection = new Set(); bulkNotice = '';
        selectedZoneId = null; zonePage = 1;
        geometrySignature = ''; markerSignature = ''; vehicleSignature = ''; mapFailure = ''; fitVehicleRequested = false;
      }
      if (!canPin() && reassignDialog?.open) reassignDialog.close();
      bulkSelection = canPin() ? pruneSelection(bulkSelection, deliveriesFor(data) || []) : new Set();
      syncSourceLabels();
      const externalSelectedId = nextSelectedId || null;
      const source = deliveriesFor(data) || [];
      const selected = source.find(delivery => delivery.id === externalSelectedId);
      const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
      const externalVehicleId = vehicleIdFor(selected, fallbackVehicleId);
      const externalSelectionChanged = externalSelectedId !== lastExternalSelectedId;
      const externalAssignmentChanged = externalSelectedId && externalVehicleId !== lastExternalVehicleId;
      lastExternalSelectedId = externalSelectedId;
      lastExternalVehicleId = externalVehicleId;
      if ((externalSelectionChanged || externalAssignmentChanged) && selected) { selectedVehicleId = externalVehicleId || selectedVehicleId; selectedDeliveryId = selected.id; }
      if (externalSelectionChanged && !externalSelectedId) selectedDeliveryId = null;
      updateVehicles(); ensureMap(); renderScene(); renderOrderList();
    },
    destroy() {
      destroyed = true;
      if (dragStart) stopDrag();
      listeners.splice(0).forEach(remove => remove());
      resizeObserver?.disconnect();
      mapMarkers.splice(0).forEach(marker => marker.remove());
      wheelZoom?.remove();
      pointLayer?.destroy();
      map?.remove?.();
    },
  };
}
