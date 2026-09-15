import { referenceIcon } from './reference-icons.mjs';
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

export function orderMapModel(deliveries, routeData) {
  const points = new Map((routeData?.points || []).filter(point =>
    typeof point?.id === 'string' && Number.isFinite(point.lng) && Number.isFinite(point.lat)
    && Math.abs(point.lng) <= 180 && Math.abs(point.lat) <= 90
  ).map(point => [point.id, [point.lng, point.lat]]));
  const mapped = (deliveries || []).flatMap(delivery => points.has(delivery.id) ? [{ delivery, coordinates: points.get(delivery.id) }] : []);
  return { mapped, unknownCount: Math.max(0, (deliveries?.length || 0) - mapped.length) };
}

function createOrderMap(element) {
  maplibregl.setWorkerUrl(new URL('./assets/vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href);
  const map = new maplibregl.Map({
    container: element,
    style: new URL('./assets/maps/dsv-korea-v1.json', import.meta.url).href,
    center: [126.995, 37.43], zoom: 10.35,
    maxBounds: [124.5, 33, 132, 39.5],
    attributionControl: false, scrollZoom: false,
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

function createOrderMarker(map, delivery, coordinates) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'order-map-marker';
  element.dataset.orderMarker = delivery.id;
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
    <section class="order-map-panel" aria-labelledby="order-map-heading">
      <div class="order-map-heading"><div><h2 id="order-map-heading">주문 배차 지도</h2><p>권역별 주문과 배차 차량</p></div><span class="order-map-count" data-order-map-count>0건</span></div>
      <div class="order-map-canvas" data-order-map-canvas aria-label="주문 위치">
        <div class="order-map-layer" data-order-map-layer></div>
        <p class="order-map-status" data-order-map-status role="status">지도 준비 중</p>
        <div class="order-map-toolbar"><label for="order-vehicle-filter">차량</label><select id="order-vehicle-filter" data-order-vehicle></select></div>
        <button type="button" class="order-scenario-trigger" data-order-scenario-open aria-haspopup="dialog">지도 시나리오</button>
        <section class="order-map-selection" data-order-selection aria-live="polite"><span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong></section>
        <p class="order-map-summary" data-order-map-summary>기준 물량 확인 중</p>
      </div>
    </section>
    <dialog class="order-scenario-dialog" data-order-scenario-dialog aria-labelledby="order-scenario-title">
      <form method="dialog" class="order-scenario-form">
        <div class="order-scenario-heading"><div><span>물량 비교</span><h2 id="order-scenario-title">지도 시나리오</h2></div><button type="button" class="order-dialog-close" data-order-scenario-close aria-label="지도 시나리오 닫기">${referenceIcon('close')}</button></div>
        <p class="order-scenario-description">불러온 전체 주문의 박스 수를 100% 기준으로 비교합니다.</p>
        <dl class="order-plan-summary"><div><dt>기준 물량 (100%)</dt><dd data-order-baseline>미확인</dd></div><div><dt>비교 물량</dt><dd data-order-target>미확인</dd></div></dl>
        <div class="order-scenario-control"><span>물량 비율 <strong data-order-volume-display>100%</strong></span><input data-order-volume-range type="range" min="80" max="120" step="1" value="100" aria-label="물량 비율 슬라이더" aria-describedby="order-volume-note"><input data-order-volume-number type="number" min="80" max="120" step="1" value="100" inputmode="numeric" aria-label="물량 비율 입력" aria-describedby="order-volume-note"><div class="order-volume-scale" aria-hidden="true"><span>80%</span><span>100%</span><span>120%</span></div></div>
        <button type="button" class="button" data-order-volume-reset>100%로 돌아가기</button>
        <p class="order-scenario-description" id="order-volume-note" data-order-volume-note>기준 물량을 확인하고 있습니다.</p>
      </form>
    </dialog>`;

  const query = selector => element.querySelector(selector);
  const vehicleSelect = query('[data-order-vehicle]');
  const canvas = query('[data-order-map-canvas]');
  const layer = query('[data-order-map-layer]');
  const mapStatus = query('[data-order-map-status]');
  const count = query('[data-order-map-count]');
  const selection = query('[data-order-selection]');
  const summary = query('[data-order-map-summary]');
  const dialog = query('[data-order-scenario-dialog]');
  const trigger = query('[data-order-scenario-open]');
  const close = query('[data-order-scenario-close]');
  const range = query('[data-order-volume-range]');
  const number = query('[data-order-volume-number]');
  const display = query('[data-order-volume-display]');
  const reset = query('[data-order-volume-reset]');
  const baseline = query('[data-order-baseline]');
  const target = query('[data-order-target]');
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
  let map = null;
  let routePromise = null;
  let mapMarkers = [];
  let resizeObserver = null;
  let destroyed = false;
  let mapFailure = '';
  const selectedVehicle = () => (data?.fleetVehicles || []).find(vehicle => vehicle.id === selectedVehicleId) ?? data?.vehicle ?? null;

  function syncControls() {
    const volume = volumeScenario(deliveriesFor(data), percent);
    range.value = String(percent);
    if (!editingPercent) number.value = String(percent);
    display.textContent = `${percent}%`;
    range.disabled = number.disabled = volume.baselineBoxes === null;
    reset.disabled = range.disabled || percent === 100;
    baseline.textContent = boxesText(volume.baselineBoxes);
    target.textContent = boxesText(volume.targetBoxes);
    note.textContent = volume.baselineBoxes === null ? '수량이 확인된 전체 주문 데이터가 필요합니다.'
      : '합계 기준의 물량 미리보기입니다. 주문별 수량과 배차는 변경하지 않습니다.';
    summary.innerHTML = `<span>기준 ${boxesText(volume.baselineBoxes)}</span><span>비교 ${percent}% (${boxesText(volume.targetBoxes)})</span><span>차량 ${vehiclesFor(data).length}대</span>`;
  }

  function updateSelection() {
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) { selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>'; return; }
    const vehicle = selectedVehicle();
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || delivery.id)}</strong><p><span>${boxesText(delivery.boxes)}</span><span>${escapeHtml(vehicle?.plate || vehicle?.id || selectedVehicleId)}</span></p>`;
  }

  function renderScene() {
    const source = deliveriesFor(data) || [];
    const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
    const vehicleDeliveries = source.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === selectedVehicleId);
    visibleDeliveries = vehicleDeliveries;
    if (!visibleDeliveries.some(delivery => delivery.id === selectedDeliveryId)) selectedDeliveryId = null;
    const model = orderMapModel(visibleDeliveries, routeData);
    const nextMarkerSignature = model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${delivery.name}:${delivery.boxes}:${coordinates}`).join('|');
    const nextGeometrySignature = `${selectedVehicleId}|${model.mapped.map(({ delivery, coordinates }) => `${delivery.id}:${coordinates}`).join('|')}`;
    if (map && nextMarkerSignature !== markerSignature) {
      markerSignature = nextMarkerSignature;
      mapMarkers.splice(0).forEach(marker => marker.remove());
      mapMarkers = model.mapped.map(({ delivery, coordinates }) => markerFactory(map, delivery, coordinates));
    }
    mapMarkers.forEach(marker => marker.element.setAttribute('aria-pressed', String(marker.element.dataset.orderMarker === selectedDeliveryId)));
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
    count.textContent = model.unknownCount ? `지도 ${model.mapped.length}건 / 위치 미등록 ${model.unknownCount}건` : `${model.mapped.length}건`;
    mapStatus.hidden = Boolean(model.mapped.length);
    if (!model.mapped.length) mapStatus.textContent = mapFailure || (routeData ? '선택 차량의 위치 정보가 등록되지 않았습니다.' : '배송지 위치를 불러오고 있습니다.');
    updateSelection();
    syncControls();
  }

  function ensureMap() {
    if (!map) {
      try {
        map = mapFactory(layer);
        mapFailure = '';
        resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => map?.resize()) : null;
        resizeObserver?.observe(canvas);
      } catch {
        mapFailure = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
        mapStatus.hidden = false;
        mapStatus.textContent = mapFailure;
        return;
      }
    }
    map.resize?.();
    if (routeData || routePromise) return;
    routePromise = Promise.resolve(loadRouteData()).then(value => {
      if (destroyed) return;
      routeData = value;
      routePromise = null;
      markerSignature = '';
      geometrySignature = '';
      renderScene();
    }).catch(() => {
      if (destroyed) return;
      routePromise = null;
      mapStatus.hidden = false;
      mapStatus.textContent = '배송지 위치를 불러오지 못했습니다. 다시 시도해 주세요.';
    });
  }

  function updateVehicles() {
    const vehicles = vehiclesFor(data);
    const nextSignature = vehicles.map(vehicle => `${vehicle.id}:${vehicle.plate}`).join('|');
    if (nextSignature !== vehicleSignature) { vehicleSignature = nextSignature; vehicleSelect.innerHTML = vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate || vehicle.id)}</option>`).join(''); }
    if (!vehicles.some(vehicle => vehicle.id === selectedVehicleId)) selectedVehicleId = vehicles.find(vehicle => vehicle.id === 'V1')?.id ?? vehicles[0]?.id ?? '';
    vehicleSelect.value = selectedVehicleId;
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
  listen(reset, 'click', () => setPercent(100));
  listen(vehicleSelect, 'change', event => { selectedVehicleId = event.target.value; selectedDeliveryId = null; renderScene(); });
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
      map?.remove?.();
    },
  };
}
