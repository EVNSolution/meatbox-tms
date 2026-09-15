import { referenceIcon } from './reference-icons.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
import { summarizeFleetTiming, vehicleOperations } from './vehicle-operations-model.mjs';
import { mountDispatchMapLayers } from './dispatch-map-layer.mjs';
import { paginate } from './pagination-model.mjs';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function volumeScenario(deliveries, value = 100) {
  const parsed = Number.parseFloat(value);
  const percent = Math.min(120, Math.max(80, Number.isFinite(parsed) ? Math.round(parsed) : 100));
  const total = Array.isArray(deliveries) && deliveries.every(delivery => Number.isFinite(delivery?.boxes) && delivery.boxes >= 0)
    ? deliveries.reduce((sum, delivery) => sum + delivery.boxes, 0) : null;
  const baselineBoxes = Number.isFinite(total) ? total : null;
  // Only preview the total. Per-order changes await the real-data and allocation contract.
  const targetBoxes = baselineBoxes === null ? null : Math.round(baselineBoxes * percent / 100);
  return { percent, baselineBoxes, targetBoxes };
}

const deliveriesFor = data => Array.isArray(data?.fleetDeliveries) ? data.fleetDeliveries : Array.isArray(data?.deliveries) ? data.deliveries : null;
const vehiclesFor = data => Array.isArray(data?.fleetVehicles) ? data.fleetVehicles : data?.vehicle ? [data.vehicle] : [];
const boxesText = boxes => Number.isFinite(boxes) && boxes >= 0 ? `${boxes.toLocaleString('ko-KR')}박스` : '미확인';
const vehicleIdFor = (delivery, fallbackVehicleId) => delivery?.vehicle?.id ?? delivery?.vehicleId ?? fallbackVehicleId ?? null;
const countText = count => `${Number(count || 0).toLocaleString('ko-KR')}곳`;
const clockText = value => {
  if (!Number.isFinite(value)) return '미확인';
  const totalMinutes = Math.round(value / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const minutes = totalMinutes % (24 * 60);
  const day = days === 0 ? '' : days === 1 ? '다음날 ' : `+${days}일 `;
  return `${day}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const durationText = minutes => {
  if (!Number.isFinite(minutes)) return '미확인';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${rest}분`;
};

export function orderAssignmentSummary(data) {
  const deliveries = deliveriesFor(data) || [];
  const vehicles = vehiclesFor(data);
  const fallbackVehicleId = deliveries === data?.deliveries ? data?.vehicle?.id : null;
  return {
    vehicles: vehicles.length,
    destinations: deliveries.length,
    boxes: volumeScenario(deliveries).baselineBoxes,
    assignments: vehicles.map(vehicle => {
      const assigned = deliveries.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === vehicle.id);
      return { vehicle, destinations: assigned.length, boxes: volumeScenario(assigned).baselineBoxes };
    }),
  };
}

export function orderMapModel(deliveries, routeData) {
  const points = new Map((routeData?.points || []).filter(point =>
    typeof point?.id === 'string' && Number.isFinite(point.lng) && Number.isFinite(point.lat)
    && Math.abs(point.lng) <= 180 && Math.abs(point.lat) <= 90
  ).map(point => [point.id, [point.lng, point.lat]]));
  const mapped = (deliveries || []).flatMap(delivery => points.has(delivery.id) ? [{ delivery, coordinates: points.get(delivery.id) }] : []);
  return { mapped, unknownCount: Math.max(0, (deliveries?.length || 0) - mapped.length) };
}

export function createOrderMap(element) {
  maplibregl.setWorkerUrl(new URL('./assets/vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href);
  const map = new maplibregl.Map({
    container: element,
    style: new URL('./assets/maps/dsv-korea-v1.json', import.meta.url).href,
    center: [126.995, 37.43], zoom: 10.35,
    maxBounds: [124.5, 33, 132, 39.5],
    attributionControl: false, scrollZoom: true,
    dragRotate: false, touchPitch: false, pitchWithRotate: false, maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  const attribution = element.querySelector('.maplibregl-ctrl-attrib');
  if (attribution) {
    const collapse = () => {
      if (!attribution.classList.contains('maplibregl-compact-show')) return;
      observer.disconnect();
      attribution.querySelector('summary')?.click();
    };
    const observer = new MutationObserver(collapse);
    observer.observe(attribution, { attributes: true, attributeFilter: ['class'] });
    collapse();
    map.once('remove', () => observer.disconnect());
  }
  return map;
}

export function createOrderMarker(map, delivery, coordinates) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'order-map-marker';
  element.dataset.orderMarker = delivery.id;
  element.dataset.orderLabel = Number.isFinite(delivery.sequence) ? String(delivery.sequence) : (delivery.name || delivery.id);
  element.setAttribute('aria-label', `${delivery.name || delivery.id} ${boxesText(delivery.boxes)} 선택`);
  const marker = new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat(coordinates).addTo(map);
  return { element, remove: () => marker.remove() };
}

export function mountOrderPlanning({
  element,
  onSelect = () => {},
  onAssign,
  loadRouteData = () => fetch('/scenario/api/route-data').then(response => {
    if (!response.ok) throw new Error('route data unavailable');
    return response.json();
  }),
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
      <div class="order-map-heading"><div><h2 id="order-map-heading">주문 배차 지도</h2><p data-order-map-description>전체 등록 주문과 선택 차량 배정</p></div><div class="order-map-controls"><label class="order-pin-visibility" data-order-pin-control hidden><span>생략 보기</span><input type="checkbox" role="switch" aria-label="전체 핀 보기" data-order-show-all-pins><span>전체 핀 보기</span></label><label class="order-region-toggle" data-order-region-control hidden><input type="checkbox" data-order-show-regions checked>권역 경계</label></div></div>
      <div class="order-map-canvas" data-order-map-canvas aria-label="주문 위치">
        <div class="order-map-layer" data-order-map-layer></div>
        <div class="order-map-status" data-order-map-status role="status"><span data-order-map-status-text>지도 준비 중</span><button type="button" class="button subtle" data-order-map-retry hidden>다시 시도</button></div>
        <button type="button" class="order-scenario-trigger" data-order-scenario-open aria-haspopup="dialog">주문 시나리오</button>
        <section class="order-map-selection" data-order-selection aria-live="polite"><span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong></section>
        <p class="order-map-summary" data-order-map-summary>기준 물량 확인 중</p>
      </div>
      <details class="order-location-info"><summary>주문 위치 정보</summary><p data-order-map-count>위치 데이터 확인 중</p></details>
    </section>
    </div>
    <details class="order-source-list" data-order-list-panel hidden><summary>주문 목록으로 찾기 <span data-order-list-total></span></summary><div class="order-source-list-content"><label>주문 검색<input type="search" data-order-search placeholder="결제번호, 주소, 기사 검색"></label><div data-order-list></div><div class="order-list-pages"><button type="button" class="button subtle" data-order-previous>이전</button><span data-order-page></span><button type="button" class="button subtle" data-order-next>다음</button></div></div></details>
    <dialog class="order-scenario-dialog" data-order-scenario-dialog aria-labelledby="order-scenario-title">
      <form method="dialog" class="order-scenario-form">
        <div class="order-scenario-heading"><div><span>물량 비교</span><h2 id="order-scenario-title">주문 시나리오</h2></div><button type="button" class="order-dialog-close" data-order-scenario-close aria-label="주문 시나리오 닫기">${referenceIcon('close')}</button></div>
        <p class="order-scenario-description">불러온 전체 주문의 박스 수를 100% 기준으로 비교합니다.</p>
        <dl class="order-plan-summary"><div><dt data-order-groups-label>총 차량</dt><dd data-order-total-vehicles>0대</dd></div><div><dt data-order-orders-label>총 배송지</dt><dd data-order-total-destinations>0곳</dd></div><div><dt>총 박스</dt><dd data-order-baseline>미확인</dd></div><div><dt>전체 소요 시간</dt><dd data-order-total-duration>미확인</dd></div><div><dt>비교 물량</dt><dd data-order-target>미확인</dd></div></dl>
        <p class="order-timing-note" data-order-timing-note>운행 시간을 확인하고 있습니다.</p>
        <div class="order-scenario-control"><span>물량 비율 <strong data-order-volume-display>100%</strong></span><input data-order-volume-range type="range" min="80" max="120" step="1" value="100" aria-label="물량 비율 슬라이더" aria-describedby="order-volume-note"><input data-order-volume-number type="number" min="80" max="120" step="1" value="100" inputmode="numeric" aria-label="물량 비율 입력" aria-describedby="order-volume-note"><div class="order-volume-scale" aria-hidden="true"><span>80%</span><span>100%</span><span>120%</span></div></div>
        <p class="order-scenario-description" id="order-volume-note" data-order-volume-note>기준 물량을 확인하고 있습니다.</p>
        <section class="order-assignment-section" aria-labelledby="order-assignment-heading"><h3 id="order-assignment-heading">기사별 물량</h3><p data-order-assignment-note>동일 차량 ID 단위이며 수신 순서로 표시합니다. 배송지를 가구 수로 환산하지 않습니다.</p><div class="order-assignment-list" data-order-assignments></div></section>
      </form>
    </dialog>
    <dialog class="order-scenario-dialog order-reassign-dialog" data-order-reassign-dialog aria-labelledby="order-reassign-title">
      <div class="order-scenario-form"><div class="order-scenario-heading"><h2 id="order-reassign-title" data-order-reassign-title>핀배차</h2><button type="button" class="order-dialog-close" data-order-reassign-close aria-label="배차 창 닫기">${referenceIcon('close')}</button></div>
      <p class="order-scenario-description" data-order-reassign-from></p>
      <label class="order-reassign-target">배정할 차량<select data-order-reassign-target aria-label="배정할 차량"></select></label>
      <p class="order-reassign-preview" data-order-reassign-preview></p><p class="order-scenario-description">같은 이름과 주소의 주문을 하나의 배송지로 묶어 배차 계산안에 반영합니다.</p>
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
  const dialog = query('[data-order-scenario-dialog]');
  const trigger = query('[data-order-scenario-open]');
  const close = query('[data-order-scenario-close]');
  const range = query('[data-order-volume-range]');
  const number = query('[data-order-volume-number]');
  const display = query('[data-order-volume-display]');
  const baseline = query('[data-order-baseline]');
  const target = query('[data-order-target]');
  const totalVehicles = query('[data-order-total-vehicles]');
  const totalDestinations = query('[data-order-total-destinations]');
  const totalDuration = query('[data-order-total-duration]');
  const timingNote = query('[data-order-timing-note]');
  const assignments = query('[data-order-assignments]');
  const note = query('[data-order-volume-note]');
  let data = null;
  let percent = 100;
  let showAllPins = false;
  let editingPercent = false;
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
  let routePromise = null;
  let mapMarkers = [];
  let resizeObserver = null;
  let wheelZoom = null;
  let destroyed = false;
  let mapFailure = '';
  let pointLayer = null;
  let sourcePoints = null;
  let sourceModel = null;
  let sourceData = null;
  let overlapIds = [];
  let selectedZoneId = null;
  let listQuery = '';
  let listPage = 1;
  let pendingAssignment = null;
  const reassignDialog = query('[data-order-reassign-dialog]');
  const imported = () => Boolean(data?.dispatchSource);
  const canPin = () => Boolean(onAssign && imported() && (!data.dispatch || (!data.dispatch.readOnly && data.dispatch.phase === 'draft')));
  const pinVehicles = () => vehiclesFor(data).filter(vehicle => !data?.dispatch || data.dispatch.candidateIds.includes(vehicle.id));
  const setText = (selector, text) => { const node = query(selector); if (node) node.textContent = text; };
  function syncSourceLabels() {
    const isSource = imported();
    const actions = query('[data-order-dispatch-actions]');
    if (actions) actions.hidden = !isSource;
    element.dataset.sourceKind = isSource ? 'file' : 'simulation';
    const pinControl = query('[data-order-pin-control]');
    if (pinControl) pinControl.hidden = !isSource;
    setText('[data-order-group-heading]', isSource ? data?.dispatch?.phase === 'unplanned' ? '후보 배송원' : '차량별 배정' : '배차 차량');
    setText('[data-order-group-note]', isSource ? '주문 수신 순서' : '수신 순서');
    setText('[data-order-map-description]', isSource ? showAllPins ? '모든 주문 위치를 표시합니다.' : '확대하면 모든 주문 위치를 표시합니다.' : '전체 등록 주문과 선택 차량 배정');
    setText('[data-order-groups-label]', isSource ? data?.dispatch?.phase === 'unplanned' ? '후보 차량' : '배정 차량' : '총 차량');
    setText('[data-order-orders-label]', isSource ? '주문 위치' : '총 배송지');
    setText('[data-order-assignment-note]', isSource ? data?.dispatch?.phase === 'unplanned' ? '배송원을 선택하고 배차 계산을 진행해 주세요.' : data?.dispatch?.phase === 'draft' ? '아직 전송하지 않은 배차 계산안입니다.' : '확정된 배차의 주문과 박스 수입니다.' : '동일 차량 ID 단위이며 수신 순서로 표시합니다. 배송지를 가구 수로 환산하지 않습니다.');
    const regionControl = query('[data-order-region-control]');
    if (regionControl) regionControl.hidden = !isSource;
    const listPanel = query('[data-order-list-panel]');
    if (listPanel) listPanel.hidden = !isSource;
    const regionNote = query('[data-order-region-note]');
    if (regionNote) regionNote.innerHTML = isSource
      ? '<strong>배송 권역</strong>경계를 클릭하면 권역 내 주문을 확인할 수 있습니다.'
      : '<strong>권역 기능 준비 중</strong> 실제 권역 데이터가 연결되면 경계와 권역 내 배송지 정보를 제공합니다.';
  }
  function syncControls() {
    const volume = volumeScenario(deliveriesFor(data), percent);
    const plan = orderAssignmentSummary(data);
    const fleetTiming = summarizeFleetTiming(vehicleOperations(data));
    range.value = String(percent);
    if (!editingPercent) number.value = String(percent);
    display.textContent = `${percent}%`;
    range.disabled = number.disabled = volume.baselineBoxes === null;
    baseline.textContent = boxesText(volume.baselineBoxes);
    target.textContent = boxesText(volume.targetBoxes);
    totalVehicles.textContent = `${plan.vehicles.toLocaleString('ko-KR')}대`;
    totalDestinations.textContent = imported() ? `${plan.destinations.toLocaleString('ko-KR')}건` : countText(plan.destinations);
    totalDuration.textContent = durationText(fleetTiming.durationMinutes);
    const unknownVehicles = fleetTiming.totalVehicles - fleetTiming.knownVehicles;
    timingNote.textContent = `시간 확인 ${fleetTiming.knownVehicles.toLocaleString('ko-KR')}/${fleetTiming.totalVehicles.toLocaleString('ko-KR')}대${unknownVehicles ? `, 나머지 ${unknownVehicles.toLocaleString('ko-KR')}대 미확인` : ''}. 시뮬레이션 계산값: 가장 이른 고정 출발부터 가장 늦은 최종 인도 완료까지`;
    if (imported()) timingNote.textContent = '운행 시간이 등록되면 전체 소요 시간을 계산합니다.';
    assignments.innerHTML = plan.assignments.map(({ vehicle, destinations, boxes }) => `<article><div><strong>${escapeHtml(vehicle.driver || '배송원 미확인')}</strong><span>${escapeHtml(vehicle.plate || vehicle.id)}</span></div><p><span>배정 배송지 ${countText(destinations)}</span><span>배정 박스 ${boxesText(boxes)}</span></p></article>`).join('') || '<p class="order-assignment-empty">배정 차량 데이터가 없습니다.</p>';
    note.textContent = volume.baselineBoxes === null ? '수량이 확인된 전체 주문 데이터가 필요합니다.'
      : '합계 기준의 물량 미리보기입니다. 주문별 수량과 배차는 변경하지 않습니다.';
    summary.innerHTML = `<span>기준 ${boxesText(volume.baselineBoxes)}</span><span>비교 ${percent}% (${boxesText(volume.targetBoxes)})</span><span>차량 ${vehiclesFor(data).length}대</span>`;
    if (imported()) {
      const stats = data.dispatchSource.summary;
      summary.innerHTML = `<span>주문 ${stats.orders.toLocaleString('ko-KR')}건</span><span>총 ${boxesText(stats.boxes)}</span><span>비교 ${percent}% (${boxesText(volume.targetBoxes)})</span>`;
      assignments.innerHTML = plan.assignments.map(({ vehicle, destinations, boxes }) => `<article><div><strong>${escapeHtml(vehicle.driver)}</strong></div><p><span>주문 ${destinations.toLocaleString('ko-KR')}건</span><span>${boxesText(boxes)}</span></p></article>`).join('');
    }
  }

  function syncDispatchActions() {
    const pinButton = query('[data-order-dispatch-pin]');
    if (!pinButton) return;
    pinButton.disabled = !canPin() || !selectedDeliveryId;
    setText('[data-order-dispatch-context]', data?.dispatch?.readOnly ? '과거 배차는 조회만 가능합니다.'
      : data?.dispatch?.phase === 'unplanned' ? '배송원을 선택한 뒤 배차 계산을 진행해 주세요.'
        : data?.dispatch?.phase === 'published' ? '확정된 배차입니다.'
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
    const currentBoxes = volumeScenario(currentOrders).baselineBoxes;
    const coordinates = vehicle.location?.coordinates;
    const position = coordinates ? ` (${coordinates[1].toFixed(4)}, ${coordinates[0].toFixed(4)})` : '';
    setText('[data-order-reassign-preview]', `대상 차량 ${vehicle.driver} / ${vehicle.plate}\n현재 ${currentOrders.length}건 / ${boxesText(currentBoxes)} → 배차 후 ${currentOrders.length + pendingAssignment.orderIds.length}건 / ${boxesText(currentBoxes + pendingAssignment.boxes)}\n${vehicle.location?.label?.replace(' 예시 위치', '') || '위치 미등록'}${position}`);
  }

  function openAssignment() {
    if (!canPin()) return;
    const chosen = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!chosen) return;
    const selected = chosen.assignmentUnitId ? visibleDeliveries.filter(item => item.assignmentUnitId === chosen.assignmentUnitId) : [chosen];
    const fromGroupId = chosen.vehicleId;
    const from = vehiclesFor(data).find(item => item.id === fromGroupId);
    pendingAssignment = { date: data.dispatchSource.date, fromGroupId, orderIds: selected.map(item => item.id), boxes: volumeScenario(selected).baselineBoxes };
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
      status.textContent = `배차 변경: ${result.changedCount}건 / ${boxesText(result.changedBoxes)}. 배차 계산안에 반영했습니다. 전체 배차 전송 시 확정됩니다.`;
      status.hidden = false;
    } catch (error) {
      const status = query('[data-order-reassign-error]');
      status.textContent = error.message || '배정을 변경하지 못했습니다.'; status.hidden = false;
    } finally { confirm.disabled = false; }
  }

  function updateSelection() {
    syncDispatchActions();
    if (imported() && selectedZoneId) {
      const region = data.dispatchRegions?.features.find(feature => feature.properties.zoneId === selectedZoneId);
      const inside = visibleDeliveries.filter(item => item.zoneIds.includes(selectedZoneId));
      selection.innerHTML = `<span>배송 권역</span><strong>${escapeHtml(region?.properties.label || selectedZoneId)}</strong><p><span>${escapeHtml(selectedZoneId)}</span><span>내부 주문 ${inside.length.toLocaleString('ko-KR')}건</span><span>${boxesText(volumeScenario(inside).baselineBoxes)}</span></p><p>품질 ${escapeHtml(region?.properties.quality || '미확인')} / 기준 ${escapeHtml(region?.properties.baseDate || '미확인')}</p>`;
      return;
    }
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) { selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>'; return; }
    const fallbackVehicleId = visibleDeliveries === data?.deliveries ? data?.vehicle?.id : null;
    const deliveryVehicleId = vehicleIdFor(delivery, fallbackVehicleId);
    const vehicle = vehiclesFor(data).find(item => item.id === deliveryVehicleId) ?? delivery.vehicle ?? null;
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || delivery.id)}</strong><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.plate || vehicle?.id || deliveryVehicleId || '차량 미확인')}</span></p>`;
    if (imported()) {
      selection.innerHTML = `<span>선택 주문 ${escapeHtml(delivery.orderNumber)}</span><strong>${escapeHtml(delivery.name)}</strong><p>${escapeHtml(delivery.address)}</p><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.driver || '배차 대기')}</span><span>권역 ${escapeHtml(delivery.regionName)}</span></p><p>배송 구역 ${delivery.zoneIds.length ? delivery.zoneIds.map(escapeHtml).join(', ') : '없음'}</p>`;
      if (overlapIds.length > 1) selection.innerHTML += `<label class="order-overlap-picker">이 지점의 주문 ${overlapIds.length}건<select data-order-overlap aria-label="겹친 주문 선택">${overlapIds.map(id => visibleDeliveries.find(item => item.id === id)).filter(Boolean).map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selectedDeliveryId ? 'selected' : ''}>${escapeHtml(item.orderNumber)} / ${escapeHtml(item.name)} / ${boxesText(item.boxes)}</option>`).join('')}</select></label>`;
      selection.innerHTML += `<button type="button" class="button subtle order-pin-action" data-order-pin-selected ${canPin() ? '' : 'disabled'}>핀배차</button>`;
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
    selectedZoneId = null;
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
      syncControls();
      return;
    }
    const model = imported() ? sourceModel : orderMapModel(source, routeData);
    const selectedModel = orderMapModel(vehicleDeliveries, routeData);
    const nextMarkerSignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${delivery.name}:${delivery.boxes}:${delivery.sequence}:${vehicleIdFor(delivery, fallbackVehicleId)}:${coordinates}`).join('|');
    const nextGeometrySignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${coordinates}`).join('|');
    if (map && imported()) {
      const zones = selectedZoneId ? [selectedZoneId] : selectedDeliveryId
        ? source.find(item => item.id === selectedDeliveryId)?.zoneIds || []
        : [...new Set(vehicleDeliveries.flatMap(item => item.zoneIds || []))];
      pointLayer.update({ points: sourcePoints, regions: data.dispatchRegions, selectedGroupId: selectedVehicleId === 'all' ? null : selectedVehicleId, selectedOrderId: selectedDeliveryId, selectedZoneIds: zones, showRegions: query('[data-order-show-regions]')?.checked !== false, showAllPins });
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
    if (imported()) count.textContent = `전체 주문 ${source.length.toLocaleString('ko-KR')}건 / 위치 등록 ${model.mapped.length.toLocaleString('ko-KR')}건 / 위치 미등록 ${model.unknownCount.toLocaleString('ko-KR')}건 / 권역 ${data.dispatchRegions?.features.length.toLocaleString('ko-KR') || '미연결'}구역. 겹친 위치의 주문도 그대로 포함합니다.`;
    canvas.dataset.orderPointCount = String(model.mapped.length);
    canvas.dataset.orderDate = data?.dispatchSource?.date || '';
    mapStatus.hidden = Boolean(model.mapped.length);
    mapRetry.hidden = true;
    if (!model.mapped.length) mapStatusText.textContent = '배송지 위치 정보가 등록되지 않았습니다.';
    updateSelection();
    syncControls();
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
      if (!pointLayer) pointLayer = layerFactory(map, { onPick(ids, region) { overlapIds = ids; selectedZoneId = region?.zoneId || null; selectedDeliveryId = ids[0] || null; renderScene(); renderOrderList(); if (selectedDeliveryId) onSelect(selectedDeliveryId); }, onError(error) { mapFailure = error?.message || '주문 지도 레이어를 불러오지 못했습니다.'; renderScene(); } });
      if (sourceData !== data) {
        sourceData = data;
        mapMarkers.splice(0).forEach(marker => marker.remove());
        routeData = { points: deliveriesFor(data).filter(item => item.coordinates).map(item => ({ id: item.id, lng: item.coordinates[0], lat: item.coordinates[1] })) };
        sourceModel = orderMapModel(deliveriesFor(data), routeData);
        sourcePoints = { type: 'FeatureCollection', features: sourceModel.mapped.map(({ delivery, coordinates }) => ({ type: 'Feature', id: delivery.id, properties: { orderId: delivery.id, groupId: delivery.vehicleId, label: delivery.orderNumber }, geometry: { type: 'Point', coordinates } })) };
      }
      routeState = 'ready';
      return;
    }
    if (routeState !== 'idle') return;
    routeState = 'loading';
    routePromise = Promise.resolve().then(loadRouteData).then(value => {
      if (destroyed) return;
      if (!value || !Array.isArray(value.points)) throw new TypeError('route data unavailable');
      routeData = value;
      routeState = 'ready';
      routePromise = null;
      markerSignature = '';
      geometrySignature = '';
      renderScene();
    }).catch(() => {
      if (destroyed) return;
      routePromise = null;
      routeState = 'failed';
      renderScene();
    });
  }

  function updateVehicles() {
    const vehicles = vehiclesFor(data);
    const rows = vehicleOperations(data);
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
      const boxes = volumeScenario(assigned).baselineBoxes;
      const departureLabel = vehicle.departure?.source === 'scenario-baseline' ? '고정 출발 (시나리오 기준)' : '고정 출발';
      const departure = vehicle.departure?.time ? escapeHtml(vehicle.departure.time) : '미등록';
      const row = rowsByVehicle.get(vehicle.id);
      const lastArrival = row?.lastArrivalEta || (vehicle.live && /완료$/.test(data?.kpi?.finishEta || '') ? 'ETA 미해당' : '미등록');
      const held = row?.timing?.heldStops || 0;
      const completion = held ? `보류 ${countText(held)}, 미확인`
        : Number.isFinite(row?.timing?.completionMs) ? `${clockText(row.timing.completionMs)}${row.timing.completed ? ' 완료' : ' 예상'}` : '미등록';
      const completionLabel = row?.timing?.completed ? '최종 인도 완료' : '최종 인도 완료 예측';
      const regionLabel = `${vehicle.region || '권역 미등록'} / ${vehicle.location?.label?.replace(' 예시 위치', '') || '위치 미등록'}`;
      if (imported()) return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong title="${escapeHtml(vehicle.driver)}">${escapeHtml(vehicle.driver)}</strong><small>${escapeHtml(vehicle.plate)}</small></span><span class="order-vehicle-load"><b>${data?.dispatch?.phase === 'unplanned' ? '배차 대기' : `주문 ${assigned.length.toLocaleString('ko-KR')}건`}</b><b>${boxesText(boxes)}</b></span><span class="order-source-regions" title="${escapeHtml(regionLabel)}">${escapeHtml(regionLabel)}</span></button>`;
      return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong>${escapeHtml(vehicle.plate || vehicle.id)}</strong><small>${escapeHtml(vehicle.driver || '배송원 미확인')}</small></span><span class="order-vehicle-load"><b>${countText(assigned.length)}</b><b>${boxesText(boxes)}</b></span><span class="order-vehicle-times"><span>${departureLabel} <strong>${departure}</strong></span><span>마지막 도착 ETA <strong>${escapeHtml(lastArrival)}</strong></span><span>${completionLabel} <strong>${escapeHtml(completion)}</strong></span></span></button>`;
    }).join('') || '<p class="order-vehicle-empty">배차 차량이 없습니다.</p>';
    if (imported()) vehicleSelect.innerHTML = `<button type="button" data-order-vehicle-id="all" aria-pressed="${selectedVehicleId === 'all'}"><span class="order-vehicle-name"><strong>${data?.dispatch?.phase === 'unplanned' ? '전체 주문' : '전체 차량'}</strong><small>${vehicles.length}대</small></span><span class="order-vehicle-load"><b>주문 ${source.length.toLocaleString('ko-KR')}건</b><b>${boxesText(volumeScenario(source).baselineBoxes)}</b></span></button>` + vehicleSelect.innerHTML;
    if (focusedVehicleId) Array.from(vehicleSelect.querySelectorAll?.('[data-order-vehicle-id]') || []).find(item => item.dataset.orderVehicleId === focusedVehicleId)?.focus();
  }

  function setPercent(value) {
    percent = volumeScenario(deliveriesFor(data), value).percent;
    syncControls();
  }

  const listeners = [];
  const listen = (node, type, listener) => { if (!node) return; node.addEventListener(type, listener); listeners.push(() => node.removeEventListener(type, listener)); };
  listen(range, 'input', event => setPercent(event.target.value));
  listen(number, 'focus', () => { editingPercent = true; });
  listen(number, 'input', event => {
    const value = Number(event.target.value);
    if (Number.isInteger(value) && value >= 80 && value <= 120) setPercent(value);
  });
  listen(number, 'change', event => { editingPercent = false; setPercent(event.target.value); });
  listen(number, 'blur', event => { editingPercent = false; setPercent(event.target.value); });
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
    selectedZoneId = null;
    overlapIds = [];
    updateVehicles();
    renderScene();
  });
  listen(canvas, 'click', event => { const marker = event.target.closest('[data-order-marker]'); if (!marker) return; selectedDeliveryId = marker.dataset.orderMarker; renderScene(); onSelect(selectedDeliveryId); });
  listen(trigger, 'click', () => dialog.showModal());
  listen(dialog, 'close', () => trigger.focus());
  listen(close, 'click', () => dialog.close());
  listen(query('[data-order-show-regions]'), 'change', renderScene);
  listen(query('[data-order-show-all-pins]'), 'change', event => {
    showAllPins = event.target.checked;
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

  syncControls();
  return {
    update(nextData, nextSelectedId) {
      const dateChanged = data?.dispatchSource?.date !== nextData?.dispatchSource?.date;
      data = nextData || null;
      if (dateChanged) {
        reassignDialog?.close();
        const result = query('[data-order-dispatch-result]');
        if (result) result.hidden = true;
        if (mapFailure) { pointLayer?.destroy(); pointLayer = null; }
        selectedVehicleId = imported() ? 'all' : 'V1'; selectedDeliveryId = null; selectedZoneId = null; overlapIds = []; listPage = 1;
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
