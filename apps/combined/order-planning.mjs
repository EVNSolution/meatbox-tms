import { referenceIcon } from './reference-icons.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
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
  loadRouteData = () => fetch('/scenario/api/route-data').then(response => {
    if (!response.ok) throw new Error('route data unavailable');
    return response.json();
  }),
  mapFactory = createOrderMap,
  markerFactory = createOrderMarker,
}) {
  if (!element) throw new TypeError('주문 배차 영역이 필요합니다.');
  element.innerHTML = `
    <div class="order-planning-layout">
    <aside class="order-vehicle-panel" aria-labelledby="order-vehicle-heading">
      <div class="order-vehicle-heading"><div><h2 id="order-vehicle-heading">배차 차량</h2><p>수신 순서</p></div></div>
      <div class="order-vehicle-list" data-order-vehicle aria-label="배차 차량 선택"></div>
      <p class="order-region-note"><strong>권역 기능 준비 중</strong> 실제 권역 데이터가 연결되면 경계와 권역 내 배송지 정보를 제공합니다.</p>
    </aside>
    <section class="order-map-panel" aria-labelledby="order-map-heading">
      <div class="order-map-heading"><div><h2 id="order-map-heading">주문 배차 지도</h2><p>전체 등록 주문과 선택 차량 배정</p></div></div>
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
    <dialog class="order-scenario-dialog" data-order-scenario-dialog aria-labelledby="order-scenario-title">
      <form method="dialog" class="order-scenario-form">
        <div class="order-scenario-heading"><div><span>물량 비교</span><h2 id="order-scenario-title">주문 시나리오</h2></div><button type="button" class="order-dialog-close" data-order-scenario-close aria-label="주문 시나리오 닫기">${referenceIcon('close')}</button></div>
        <p class="order-scenario-description">불러온 전체 주문의 박스 수를 100% 기준으로 비교합니다.</p>
        <dl class="order-plan-summary"><div><dt>총 차량</dt><dd data-order-total-vehicles>0대</dd></div><div><dt>총 배송지</dt><dd data-order-total-destinations>0곳</dd></div><div><dt>총 박스</dt><dd data-order-baseline>미확인</dd></div><div><dt>전체 소요 시간</dt><dd>집계 기준 대기</dd></div><div><dt>비교 물량</dt><dd data-order-target>미확인</dd></div></dl>
        <div class="order-scenario-control"><span>물량 비율 <strong data-order-volume-display>100%</strong></span><input data-order-volume-range type="range" min="80" max="120" step="1" value="100" aria-label="물량 비율 슬라이더" aria-describedby="order-volume-note"><input data-order-volume-number type="number" min="80" max="120" step="1" value="100" inputmode="numeric" aria-label="물량 비율 입력" aria-describedby="order-volume-note"><div class="order-volume-scale" aria-hidden="true"><span>80%</span><span>100%</span><span>120%</span></div></div>
        <p class="order-scenario-description" id="order-volume-note" data-order-volume-note>기준 물량을 확인하고 있습니다.</p>
        <section class="order-assignment-section" aria-labelledby="order-assignment-heading"><h3 id="order-assignment-heading">기사별 실제 배정</h3><p>동일 차량 ID 단위이며 수신 순서로 표시합니다. 배송지를 가구 수로 환산하지 않습니다.</p><div class="order-assignment-list" data-order-assignments></div></section>
      </form>
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
  const assignments = query('[data-order-assignments]');
  const note = query('[data-order-volume-note]');
  let data = null;
  let percent = 100;
  let editingPercent = false;
  let selectedVehicleId = 'V1';
  let selectedDeliveryId = null;
  let lastExternalSelectedId = null;
  let lastExternalVehicleId = null;
  let vehicleSignature = '';
  let markerSignature = '';
  let geometrySignature = '';
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
  function syncControls() {
    const volume = volumeScenario(deliveriesFor(data), percent);
    const plan = orderAssignmentSummary(data);
    range.value = String(percent);
    if (!editingPercent) number.value = String(percent);
    display.textContent = `${percent}%`;
    range.disabled = number.disabled = volume.baselineBoxes === null;
    baseline.textContent = boxesText(volume.baselineBoxes);
    target.textContent = boxesText(volume.targetBoxes);
    totalVehicles.textContent = `${plan.vehicles.toLocaleString('ko-KR')}대`;
    totalDestinations.textContent = countText(plan.destinations);
    assignments.innerHTML = plan.assignments.map(({ vehicle, destinations, boxes }) => `<article><div><strong>${escapeHtml(vehicle.driver || '배송원 미확인')}</strong><span>${escapeHtml(vehicle.plate || vehicle.id)}</span></div><p><span>배정 배송지 ${countText(destinations)}</span><span>배정 박스 ${boxesText(boxes)}</span></p></article>`).join('') || '<p class="order-assignment-empty">배정 차량 데이터가 없습니다.</p>';
    note.textContent = volume.baselineBoxes === null ? '수량이 확인된 전체 주문 데이터가 필요합니다.'
      : '합계 기준의 물량 미리보기입니다. 주문별 수량과 배차는 변경하지 않습니다.';
    summary.innerHTML = `<span>기준 ${boxesText(volume.baselineBoxes)}</span><span>비교 ${percent}% (${boxesText(volume.targetBoxes)})</span><span>차량 ${vehiclesFor(data).length}대</span>`;
  }

  function updateSelection() {
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) { selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>'; return; }
    const fallbackVehicleId = visibleDeliveries === data?.deliveries ? data?.vehicle?.id : null;
    const deliveryVehicleId = vehicleIdFor(delivery, fallbackVehicleId);
    const vehicle = vehiclesFor(data).find(item => item.id === deliveryVehicleId) ?? delivery.vehicle ?? null;
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || delivery.id)}</strong><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.plate || vehicle?.id || deliveryVehicleId || '차량 미확인')}</span></p>`;
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
      mapRetry.hidden = routeState !== 'failed';
      updateSelection();
      syncControls();
      return;
    }
    const model = orderMapModel(source, routeData);
    const selectedModel = orderMapModel(vehicleDeliveries, routeData);
    const nextMarkerSignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${delivery.name}:${delivery.boxes}:${delivery.sequence}:${vehicleIdFor(delivery, fallbackVehicleId)}:${coordinates}`).join('|');
    const nextGeometrySignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${coordinates}`).join('|');
    if (map && nextMarkerSignature !== markerSignature) {
      markerSignature = nextMarkerSignature;
      mapMarkers.splice(0).forEach(marker => marker.remove());
      mapMarkers = model.mapped.map(({ delivery, coordinates }) => ({ ...markerFactory(map, delivery, coordinates), delivery }));
    }
    mapMarkers.forEach(marker => {
      marker.element.setAttribute('data-selected-vehicle', String(vehicleIdFor(marker.delivery, fallbackVehicleId) === selectedVehicleId));
      marker.element.setAttribute('aria-pressed', String(marker.element.dataset.orderMarker === selectedDeliveryId));
    });
    if (map && nextGeometrySignature !== geometrySignature) {
      geometrySignature = nextGeometrySignature;
      const coordinates = model.mapped.map(item => item.coordinates);
      if (coordinates.length === 1) map.jumpTo({ center: coordinates[0], zoom: 15 });
      if (coordinates.length > 1) {
        const lngs = coordinates.map(point => point[0]);
        const lats = coordinates.map(point => point[1]);
        map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: { top: 72, bottom: 92, left: 48, right: 48 }, maxZoom: 15, duration: 0 });
      }
    }
    count.textContent = `지도 ${model.mapped.length.toLocaleString('ko-KR')}곳 / 전체 위치 미등록 ${model.unknownCount.toLocaleString('ko-KR')}곳 / 선택 차량 미등록 ${selectedModel.unknownCount.toLocaleString('ko-KR')}곳`;
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
    if (!vehicles.some(vehicle => vehicle.id === selectedVehicleId)) selectedVehicleId = vehicles.find(vehicle => vehicle.id === 'V1')?.id ?? vehicles[0]?.id ?? '';
    const source = deliveriesFor(data) || [];
    const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
    const nextSignature = `${selectedVehicleId}|${data?.kpi?.finishEta || ''}|${vehicles.map(vehicle => `${vehicle.id}:${vehicle.plate}:${vehicle.driver}:${vehicle.departure?.time || ''}:${vehicle.departure?.source || ''}`).join('|')}|${source.map(delivery => `${delivery.id}:${vehicleIdFor(delivery, fallbackVehicleId)}:${delivery.boxes}`).join('|')}`;
    if (nextSignature === vehicleSignature) return;
    vehicleSignature = nextSignature;
    const focusedVehicleId = typeof document === 'object' && vehicleSelect.contains?.(document.activeElement) ? document.activeElement?.dataset?.orderVehicleId : null;
    vehicleSelect.innerHTML = vehicles.map(vehicle => {
      const assigned = source.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === vehicle.id);
      const boxes = volumeScenario(assigned).baselineBoxes;
      const departureLabel = vehicle.departure?.source === 'scenario-baseline' ? '고정 출발 (시나리오 기준)' : '고정 출발';
      const departure = vehicle.departure?.time ? escapeHtml(vehicle.departure.time) : '미등록';
      const finishEta = vehicle.id === data?.vehicle?.id && typeof data?.kpi?.finishEta === 'string' ? data.kpi.finishEta.trim() : '';
      const lastArrival = finishEta ? /완료$/.test(finishEta) ? 'ETA 미해당' : escapeHtml(finishEta) : '미등록';
      return `<button type="button" data-order-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}"><span class="order-vehicle-name"><strong>${escapeHtml(vehicle.plate || vehicle.id)}</strong><small>${escapeHtml(vehicle.driver || '배송원 미확인')}</small></span><span class="order-vehicle-load"><b>${countText(assigned.length)}</b><b>${boxesText(boxes)}</b></span><span class="order-vehicle-times"><span>${departureLabel} <strong>${departure}</strong></span><span>마지막 도착 ETA <strong>${lastArrival}</strong></span><span>최종 인도 완료 예측 <strong>미등록</strong></span></span></button>`;
    }).join('') || '<p class="order-vehicle-empty">배차 차량이 없습니다.</p>';
    if (focusedVehicleId) Array.from(vehicleSelect.querySelectorAll?.('[data-order-vehicle-id]') || []).find(item => item.dataset.orderVehicleId === focusedVehicleId)?.focus();
  }

  function setPercent(value) {
    percent = volumeScenario(deliveriesFor(data), value).percent;
    syncControls();
  }

  const listeners = [];
  const listen = (node, type, listener) => { node.addEventListener(type, listener); listeners.push(() => node.removeEventListener(type, listener)); };
  listen(range, 'input', event => setPercent(event.target.value));
  listen(number, 'focus', () => { editingPercent = true; });
  listen(number, 'input', event => {
    const value = Number(event.target.value);
    if (Number.isInteger(value) && value >= 80 && value <= 120) setPercent(value);
  });
  listen(number, 'change', event => { editingPercent = false; setPercent(event.target.value); });
  listen(number, 'blur', event => { editingPercent = false; setPercent(event.target.value); });
  listen(mapRetry, 'click', () => {
    if (routeState !== 'failed') return;
    routeState = 'idle';
    ensureMap();
    renderScene();
  });
  listen(vehicleSelect, 'click', event => {
    const vehicle = event.target.closest?.('[data-order-vehicle-id]');
    if (!vehicle || vehicle.dataset.orderVehicleId === selectedVehicleId) return;
    selectedVehicleId = vehicle.dataset.orderVehicleId;
    selectedDeliveryId = null;
    updateVehicles();
    renderScene();
  });
  listen(canvas, 'click', event => { const marker = event.target.closest('[data-order-marker]'); if (!marker) return; selectedDeliveryId = marker.dataset.orderMarker; renderScene(); onSelect(selectedDeliveryId); });
  listen(trigger, 'click', () => dialog.showModal());
  listen(dialog, 'close', () => trigger.focus());
  listen(close, 'click', () => dialog.close());

  syncControls();
  return {
    update(nextData, nextSelectedId) {
      data = nextData || null;
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
      updateVehicles(); ensureMap(); renderScene();
    },
    destroy() {
      destroyed = true;
      listeners.splice(0).forEach(remove => remove());
      resizeObserver?.disconnect();
      mapMarkers.splice(0).forEach(marker => marker.remove());
      wheelZoom?.remove();
      map?.remove?.();
    },
  };
}
