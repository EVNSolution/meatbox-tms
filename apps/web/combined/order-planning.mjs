import { createOrderMap, createOrderMarker, orderMapModel } from '../src/shared/maps/order-map.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
import { vehicleOperations } from './vehicle-operations-model.mjs';
import { mountDispatchMapLayers } from './dispatch-map-layer.mjs';
import { paginate } from './pagination-model.mjs';
import { bundleDeliveries } from './delivery-bundles.mjs';
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
    <aside class="order-vehicle-panel" aria-labelledby="order-vehicle-heading">
      <div class="order-vehicle-heading"><div><h2 id="order-vehicle-heading" data-order-group-heading>배차 차량</h2><p data-order-group-note>수신 순서</p></div></div>
      <div class="order-vehicle-list" data-order-vehicle aria-label="배차 차량 선택"></div>
      <div class="order-dispatch-actions" data-order-dispatch-actions hidden><button type="button" class="button subtle" data-order-dispatch-pin disabled>핀배차</button><p data-order-dispatch-context>차량 또는 지도 주문을 선택해 주세요.</p><p data-order-dispatch-result role="status" hidden></p></div>
      <p class="order-region-note" data-order-region-note><strong>권역 기능 준비 중</strong> 실제 권역 데이터가 연결되면 경계와 권역 내 배송지 정보를 제공합니다.</p>
    </aside>
    <section class="order-map-panel" aria-labelledby="order-map-heading">
      <div class="order-map-heading"><div><h2 id="order-map-heading">주문 배차 지도</h2><p data-order-map-description>전체 등록 주문과 선택 차량 배정</p></div><div class="order-map-controls"><fieldset class="order-map-mode" data-order-map-mode-control hidden><legend class="sr-only">지도 표시 단위</legend><label><input type="radio" name="order-map-mode" value="regions" data-order-map-mode checked><span>권역 단위</span></label><label><input type="radio" name="order-map-mode" value="orders" data-order-map-mode><span>주문 단위</span></label></fieldset></div></div>
      <div class="order-map-canvas" data-order-map-canvas aria-label="주문 위치">
        <div class="order-map-layer" data-order-map-layer></div>
        <div class="order-map-status" data-order-map-status role="status"><span data-order-map-status-text>지도 준비 중</span><button type="button" class="button subtle" data-order-map-retry hidden>다시 시도</button></div>
        <section class="order-map-selection" data-order-selection aria-live="polite"><span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong></section>
        <p class="order-map-summary" data-order-map-summary>총 물량 확인 중</p>
      </div>
      <details class="order-location-info"><summary>주문 위치 정보</summary><p data-order-map-count>위치 데이터 확인 중</p></details>
    </section>
    </div>
    <details class="order-source-list" data-order-list-panel hidden><summary>주문 목록으로 찾기 <span data-order-list-total></span></summary><div class="order-source-list-content"><label>주문 검색<input type="search" data-order-search placeholder="결제번호, 주소, 기사 검색"></label><div data-order-list></div><div class="order-list-pages"><button type="button" class="button subtle" data-order-previous>이전</button><span data-order-page></span><button type="button" class="button subtle" data-order-next>다음</button></div></div></details>
    <dialog class="order-dialog order-reassign-dialog" data-order-reassign-dialog aria-labelledby="order-reassign-title">
      <div class="order-dialog-body"><div class="order-dialog-heading"><h2 id="order-reassign-title" data-order-reassign-title>핀배차</h2><button type="button" class="order-dialog-close" data-order-reassign-close aria-label="배차 창 닫기">${referenceIcon('close')}</button></div>
      <p class="order-dialog-description" data-order-reassign-from></p>
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
  const reassignDialog = query('[data-order-reassign-dialog]');
  const imported = () => Boolean(data?.dispatchSource);
  const canPin = () => Boolean(onAssign && imported() && (!data.dispatch || (!data.dispatch.readOnly && ['draft', 'amending'].includes(data.dispatch.phase))));
  const selectedAssignmentProtected = () => Boolean(visibleDeliveries.find(item => item.id === selectedDeliveryId)?.assignmentProtected);
  const pinVehicles = () => vehiclesFor(data).filter(vehicle => !data?.dispatch || data.dispatch.candidateIds.includes(vehicle.id));
  const setText = (selector, text) => { const node = query(selector); if (node) node.textContent = text; };
  function syncSourceLabels() {
    const isSource = imported();
    const actions = query('[data-order-dispatch-actions]');
    if (actions) actions.hidden = !isSource;
    element.dataset.sourceKind = isSource ? 'file' : 'simulation';
    const modeControl = query('[data-order-map-mode-control]');
    if (modeControl) modeControl.hidden = !isSource;
    setText('[data-order-group-heading]', isSource ? data?.dispatch?.phase === 'unplanned' ? '후보 배송원' : '차량별 배정' : '배차 차량');
    setText('[data-order-group-note]', isSource ? '주문 수신 순서' : '수신 순서');
    setText('[data-order-map-description]', isSource
      ? mapMode === 'regions' ? '지도를 확대하면 권역 중앙에 주문 수가 표시됩니다.' : '모든 주문 핀을 표시합니다.'
      : '전체 등록 주문과 선택 차량 배정');
    const listPanel = query('[data-order-list-panel]');
    if (listPanel) listPanel.hidden = !isSource;
    const regionNote = query('[data-order-region-note]');
    if (regionNote) regionNote.innerHTML = isSource
      ? '<strong>배송 권역</strong>제공된 권역 경계와 주문의 권역 소속으로 수량을 집계합니다.'
      : '<strong>권역 기능 준비 중</strong> 실제 권역 데이터가 연결되면 경계와 권역 내 배송지 정보를 제공합니다.';
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
    confirm.disabled = !vehicle || targetId === pendingAssignment.fromGroupId;
    if (confirm.disabled) { setText('[data-order-reassign-preview]', '배정할 다른 차량을 선택해 주세요.'); return; }
    const currentOrders = visibleDeliveries.filter(item => item.vehicleId === targetId);
    const currentBoxes = totalBoxes(currentOrders);
    const coordinates = vehicle.location?.coordinates;
    const position = coordinates ? ` (${coordinates[1].toFixed(4)}, ${coordinates[0].toFixed(4)})` : '';
    const nextBoxes = currentBoxes === null || pendingAssignment.boxes === null ? null : currentBoxes + pendingAssignment.boxes;
    setText('[data-order-reassign-preview]', `대상 차량 ${vehicle.driver} / ${vehicle.plate}\n현재 ${currentOrders.length}건 / ${boxesText(currentBoxes)} → 배차 후 ${currentOrders.length + pendingAssignment.orderIds.length}건 / ${boxesText(nextBoxes)}\n${vehicle.location?.label?.replace(' 예시 위치', '') || '위치 미등록'}${position}`);
  }

  function openAssignment() {
    if (!canPin() || selectedAssignmentProtected()) return;
    const chosen = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!chosen) return;
    const selected = chosen.assignmentUnitId ? visibleDeliveries.filter(item => item.assignmentUnitId === chosen.assignmentUnitId) : [chosen];
    const fromGroupId = chosen.vehicleId;
    const from = vehiclesFor(data).find(item => item.id === fromGroupId);
    pendingAssignment = { date: data.dispatchSource.date, fromGroupId, orderIds: selected.map(item => item.id), boxes: totalBoxes(selected) };
    setText('[data-order-reassign-title]', '핀배차');
    setText('[data-order-reassign-from]', `${chosen.name} / ${selected.length}건 / ${boxesText(pendingAssignment.boxes)} / ${from?.driver || '배차 대기'}`);
    const select = query('[data-order-reassign-target]');
    select.innerHTML = '<option value="">차량을 선택해 주세요</option>' + pinVehicles().filter(vehicle => vehicle.id !== fromGroupId).map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.driver)} / ${escapeHtml(vehicle.plate)}</option>`).join('');
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
      updateVehicles(); renderScene();
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
    selection.hidden = imported() && mapMode === 'regions';
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) { selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>'; return; }
    const fallbackVehicleId = visibleDeliveries === data?.deliveries ? data?.vehicle?.id : null;
    const deliveryVehicleId = vehicleIdFor(delivery, fallbackVehicleId);
    const vehicle = vehiclesFor(data).find(item => item.id === deliveryVehicleId) ?? delivery.vehicle ?? null;
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || '배송지 미등록')}</strong><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.plate || '차량 미확인')}</span></p>`;
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
    list.innerHTML = paged.items.map(item => `<button type="button" data-order-list-id="${escapeHtml(item.id)}" aria-pressed="${item.id === selectedDeliveryId}"><strong>${escapeHtml(item.orderNumber)}</strong><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.driver)}</span><b>${boxesText(item.boxes)}</b></button>`).join('') || '<p>일치하는 주문이 없습니다.</p>';
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
      const zones = selectedDeliveryId
        ? source.find(item => item.id === selectedDeliveryId)?.zoneIds || []
        : selectedVehicleId === 'all' ? [] : [...new Set(vehicleDeliveries.flatMap(item => item.zoneIds || []))];
      pointLayer.update({ points: sourcePoints, regions: sourceRegions, selectedGroupId: selectedVehicleId === 'all' ? null : selectedVehicleId, selectedOrderId: selectedDeliveryId, selectedZoneIds: zones, mode: mapMode });
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
    mapStatus.hidden = Boolean(model.mapped.length);
    mapRetry.hidden = true;
    if (!model.mapped.length) mapStatusText.textContent = '배송지 위치 정보가 등록되지 않았습니다.';
    updateSelection();
    syncSummary();
  }

  function ensureMap() {
    if (!map) {
      try {
        map = mapFactory(layer);
        wheelZoom = installModifierWheelZoom(map);
        mapFailure = '';
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
      if (!pointLayer) pointLayer = layerFactory(map, { onPick(ids) { overlapIds = ids; selectedDeliveryId = ids[0] || null; if (!selectedDeliveryId) { selectedVehicleId = 'all'; fitVehicleRequested = false; updateVehicles(); } renderScene(); renderOrderList(); if (selectedDeliveryId) onSelect(selectedDeliveryId); }, onError(error) { mapFailure = error?.message || '주문 지도 레이어를 불러오지 못했습니다.'; renderScene(); } });
      if (sourceData !== data) {
        sourceData = data;
        mapMarkers.splice(0).forEach(marker => marker.remove());
        routeData = { points: deliveriesFor(data).filter(item => item.coordinates).map(item => ({ id: item.id, lng: item.coordinates[0], lat: item.coordinates[1] })) };
        sourceModel = orderMapModel(deliveriesFor(data), routeData);
        sourcePoints = { type: 'FeatureCollection', features: sourceModel.mapped.map(({ delivery, coordinates }) => ({ type: 'Feature', id: delivery.id, properties: { orderId: delivery.id, groupId: delivery.vehicleId, label: delivery.orderNumber }, geometry: { type: 'Point', coordinates } })) };
        sourceRegions = regionOrderCounts(data.dispatchRegions, deliveriesFor(data));
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
      const regionLabel = `${vehicle.region || '권역 미등록'} / ${vehicle.location?.label?.replace(' 예시 위치', '') || '위치 미등록'}`;
      if (imported()) return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong title="${escapeHtml(vehicle.driver)}">${escapeHtml(vehicle.driver)}</strong><small>${escapeHtml(vehicle.plate)}</small></span><span class="order-vehicle-load"><b>${data?.dispatch?.phase === 'unplanned' ? '배차 대기' : `${countText(bundleDeliveries(assigned).length)} / 주문 ${assigned.length.toLocaleString('ko-KR')}건`}</b><b>${boxesText(boxes)}</b></span><span class="order-source-regions" title="${escapeHtml(regionLabel)}">${escapeHtml(regionLabel)}</span></button>`;
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
    if (mapMode === 'regions') { selectedDeliveryId = null; overlapIds = []; }
    syncSourceLabels();
    renderScene();
  });
  listen(selection, 'change', event => { if (event.target.matches?.('[data-order-overlap]')) pickSourceOrder(event.target.value); });
  listen(selection, 'click', event => { if (event.target.closest?.('[data-order-pin-selected]')) openAssignment('pin'); });
  listen(query('[data-order-dispatch-pin]'), 'click', () => openAssignment('pin'));
  listen(query('[data-order-reassign-target]'), 'change', updateAssignmentPreview);
  listen(query('[data-order-reassign-confirm]'), 'click', applyAssignment);
  listen(query('[data-order-reassign-cancel]'), 'click', () => reassignDialog.close());
  listen(query('[data-order-reassign-close]'), 'click', () => reassignDialog.close());
  listen(reassignDialog, 'close', () => { pendingAssignment = null; query('[data-order-dispatch-pin]')?.focus(); });
  listen(query('[data-order-search]'), 'input', event => { listQuery = event.target.value; listPage = 1; renderOrderList(); });
  listen(query('[data-order-list]'), 'click', event => {
    const item = event.target.closest('[data-order-list-id]');
    if (!item) return;
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
      element.dataset.sourceKind = 'unavailable';
      setText('[data-order-group-heading]', '후보 배송원');
      setText('[data-order-group-note]', empty ? '0명' : '자료 확인 전');
      vehicleSelect.innerHTML = '<p class="order-vehicle-empty">주문 자료가 등록되면 후보 배송원을 표시합니다.</p>';
      query('[data-order-dispatch-actions]').hidden = false;
      query('[data-order-dispatch-pin]').disabled = true;
      setText('[data-order-dispatch-context]', '주문과 계산안이 준비되면 핀배차를 사용할 수 있습니다.');
      query('[data-order-dispatch-result]').hidden = true;
      query('[data-order-map-mode-control]').hidden = false;
      query('[data-order-map-mode-control]').querySelectorAll('input').forEach(input => { input.disabled = true; });
      setText('[data-order-map-description]', '주문 위치와 배송 권역을 표시하는 영역입니다.');
      query('[data-order-region-note]').innerHTML = '<strong>배송 권역</strong>주문 자료가 등록되면 권역별 수량을 표시합니다.';
      mapStatus.hidden = false; mapRetry.hidden = true; mapStatusText.textContent = message;
      count.textContent = empty ? '등록된 주문 위치가 없습니다.' : '주문 위치를 아직 확인하지 못했습니다.';
      selection.hidden = false;
      selection.innerHTML = '<span>선택 주문</span><strong>주문이 등록되면 지도에서 선택할 수 있습니다.</strong>';
      summary.textContent = empty ? '주문 0건 · 총 0박스' : '주문 수량 확인 전';
      delete canvas.dataset.orderPointCount; delete canvas.dataset.orderDate;
      const listPanel = query('[data-order-list-panel]');
      listPanel.hidden = false; listPanel.open = true;
      query('[data-order-search]').value = ''; query('[data-order-search]').disabled = true;
      setText('[data-order-list-total]', empty ? '0건' : '확인 전');
      query('[data-order-list]').innerHTML = `<p class="order-vehicle-empty">${escapeHtml(message)}</p>`;
      setText('[data-order-page]', empty ? '0건' : '확인 전');
      query('[data-order-previous]').disabled = true; query('[data-order-next]').disabled = true;
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
        geometrySignature = ''; markerSignature = ''; vehicleSignature = ''; mapFailure = ''; fitVehicleRequested = false;
      }
      if (!canPin() && reassignDialog?.open) reassignDialog.close();
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
      listeners.splice(0).forEach(remove => remove());
      resizeObserver?.disconnect();
      mapMarkers.splice(0).forEach(marker => marker.remove());
      wheelZoom?.remove();
      pointLayer?.destroy();
      map?.remove?.();
    },
  };
}
