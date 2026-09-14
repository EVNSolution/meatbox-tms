const BOXES_PER_VEHICLE = 60;
const MAX_VEHICLES = 130;
const MAX_BOXES = BOXES_PER_VEHICLE * MAX_VEHICLES;
const MARKER_POSITIONS = [
  [18, 24], [34, 63], [47, 38], [60, 72],
  [69, 21], [78, 51], [26, 81], [52, 12],
];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const clampBoxes = value => {
  const parsed = Number.parseInt(value, 10);
  return Math.min(MAX_BOXES, Math.max(0, Number.isFinite(parsed) ? parsed : 0));
};

const vehicleIdFor = (delivery, fallbackVehicleId) => delivery?.vehicle?.id ?? delivery?.vehicleId ?? fallbackVehicleId ?? null;

export function mountOrderPlanning({ element, onSelect = () => {} }) {
  if (!element) throw new TypeError('주문 배차 영역이 필요합니다.');

  element.innerHTML = `
    <div class="order-planning-layout">
      <section class="order-map-panel" aria-labelledby="order-map-heading">
        <div class="order-map-heading">
          <div><h2 id="order-map-heading">주문 배차 지도</h2><p>예시 주문 위치</p></div>
          <span class="order-map-count" data-order-map-count>0건</span>
        </div>
        <div class="order-map-canvas" data-order-map-canvas aria-label="선택 차량의 예시 주문 위치"></div>
      </section>
      <aside class="order-planning-panel" aria-label="배차 예시 설정">
        <div class="order-planning-title"><h2>배차 예시</h2><span>차량당 60박스</span></div>
        <label class="field order-vehicle-field"><span>차량 선택</span><select data-order-vehicle></select></label>
        <div class="order-volume-heading"><label for="order-box-range">배송량</label><strong data-order-box-display>7,800박스</strong></div>
        <input class="order-box-range" data-order-box-range id="order-box-range" type="range" min="0" max="7800" step="60" value="7800" aria-describedby="order-box-help">
        <div class="order-box-entry">
          <label for="order-box-count">박스 수량</label>
          <input data-order-box-number id="order-box-count" type="number" min="0" max="7800" step="1" value="7800" inputmode="numeric">
        </div>
        <p class="order-box-help" id="order-box-help">슬라이더를 드래그하거나 포커스 후 휠로 조정</p>
        <dl class="order-plan-summary">
          <div><dt>총 배송량</dt><dd data-order-total>7,800박스</dd></div>
          <div><dt>필요 차량</dt><dd data-order-required>130대</dd></div>
        </dl>
        <section class="order-map-selection" data-order-selection aria-live="polite">
          <span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>
        </section>
      </aside>
    </div>`;

  const vehicleSelect = element.querySelector('[data-order-vehicle]');
  const range = element.querySelector('[data-order-box-range]');
  const number = element.querySelector('[data-order-box-number]');
  const boxDisplay = element.querySelector('[data-order-box-display]');
  const total = element.querySelector('[data-order-total]');
  const required = element.querySelector('[data-order-required]');
  const canvas = element.querySelector('[data-order-map-canvas]');
  const count = element.querySelector('[data-order-map-count]');
  const selection = element.querySelector('[data-order-selection]');

  let data = null;
  let boxCount = MAX_BOXES;
  let selectedVehicleId = 'V1';
  let selectedDeliveryId = null;
  let lastExternalSelectedId = null;
  let vehicleSignature = '';
  let markerSignature = '';
  let visibleDeliveries = [];

  const selectedVehicle = () => (data?.fleetVehicles || []).find(vehicle => vehicle.id === selectedVehicleId) ?? data?.vehicle ?? null;

  function updateVolume(value) {
    boxCount = clampBoxes(value);
    range.value = String(boxCount);
    number.value = String(boxCount);
    const formatted = boxCount.toLocaleString('ko-KR');
    const vehicles = Math.ceil(boxCount / BOXES_PER_VEHICLE);
    boxDisplay.textContent = `${formatted}박스`;
    total.textContent = `${formatted}박스`;
    required.textContent = `${vehicles.toLocaleString('ko-KR')}대`;
  }

  function updateSelection() {
    const delivery = visibleDeliveries.find(item => item.id === selectedDeliveryId);
    if (!delivery) {
      selection.innerHTML = '<span>선택 주문</span><strong>지도에서 주문을 선택해 주세요.</strong>';
      return;
    }
    const vehicle = selectedVehicle();
    selection.innerHTML = `<span>선택 주문</span><strong>${escapeHtml(delivery.name || delivery.id)}</strong><p>${escapeHtml(delivery.boxes ?? 0)}박스 · ${escapeHtml(vehicle?.plate || vehicle?.id || selectedVehicleId)}</p>`;
  }

  function renderMarkers() {
    const source = data?.fleetDeliveries?.length ? data.fleetDeliveries : data?.deliveries || [];
    const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
    visibleDeliveries = source.filter(delivery => vehicleIdFor(delivery, fallbackVehicleId) === selectedVehicleId).slice(0, 8);
    if (!visibleDeliveries.some(delivery => delivery.id === selectedDeliveryId)) selectedDeliveryId = null;

    const nextSignature = visibleDeliveries.map(delivery => `${delivery.id}:${delivery.name}:${delivery.boxes}`).join('|');
    if (nextSignature !== markerSignature) {
      markerSignature = nextSignature;
      canvas.innerHTML = visibleDeliveries.map((delivery, index) => {
        const [top, left] = MARKER_POSITIONS[index];
        return `<button type="button" class="order-map-marker" data-order-marker="${escapeHtml(delivery.id)}" style="--marker-top:${top}%;--marker-left:${left}%" aria-label="${escapeHtml(delivery.name || delivery.id)} 주문 선택"><span>${index + 1}</span></button>`;
      }).join('');
    }
    canvas.querySelectorAll('[data-order-marker]').forEach(marker => marker.setAttribute('aria-pressed', String(marker.dataset.orderMarker === selectedDeliveryId)));
    count.textContent = `${visibleDeliveries.length}건`;
    updateSelection();
  }

  function updateVehicles() {
    const vehicles = data?.fleetVehicles?.length ? data.fleetVehicles : data?.vehicle ? [data.vehicle] : [];
    const nextSignature = vehicles.map(vehicle => `${vehicle.id}:${vehicle.plate}`).join('|');
    if (nextSignature !== vehicleSignature) {
      vehicleSignature = nextSignature;
      vehicleSelect.innerHTML = vehicles.map(vehicle => `<option value="${escapeHtml(vehicle.id)}">${escapeHtml(vehicle.plate || vehicle.id)}</option>`).join('');
    }
    if (!vehicles.some(vehicle => vehicle.id === selectedVehicleId)) selectedVehicleId = vehicles.find(vehicle => vehicle.id === 'V1')?.id ?? vehicles[0]?.id ?? '';
    vehicleSelect.value = selectedVehicleId;
  }

  const onRangeInput = event => updateVolume(event.target.value);
  const onNumberInput = event => updateVolume(event.target.value);
  const onVehicleChange = event => {
    selectedVehicleId = event.target.value;
    selectedDeliveryId = null;
    markerSignature = '';
    renderMarkers();
  };
  const onRangeWheel = event => {
    if (document.activeElement !== range) return;
    event.preventDefault();
    const horizontal = Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0);
    const increase = horizontal ? event.deltaX > 0 : event.deltaY < 0;
    updateVolume(boxCount + (increase ? BOXES_PER_VEHICLE : -BOXES_PER_VEHICLE));
  };
  const onCanvasClick = event => {
    const marker = event.target.closest('[data-order-marker]');
    if (!marker) return;
    selectedDeliveryId = marker.dataset.orderMarker;
    renderMarkers();
    onSelect(selectedDeliveryId);
  };

  range.addEventListener('input', onRangeInput);
  range.addEventListener('wheel', onRangeWheel, { passive: false });
  number.addEventListener('input', onNumberInput);
  vehicleSelect.addEventListener('change', onVehicleChange);
  canvas.addEventListener('click', onCanvasClick);

  return {
    update(nextData, nextSelectedId) {
      data = nextData || null;
      const externalSelectedId = nextSelectedId || null;
      const externalSelectionChanged = externalSelectedId !== lastExternalSelectedId;
      lastExternalSelectedId = externalSelectedId;
      if (externalSelectionChanged && externalSelectedId) {
        const source = data?.fleetDeliveries?.length ? data.fleetDeliveries : data?.deliveries || [];
        const selected = source.find(delivery => delivery.id === externalSelectedId);
        if (selected) {
          const fallbackVehicleId = source === data?.deliveries ? data?.vehicle?.id : null;
          selectedVehicleId = vehicleIdFor(selected, fallbackVehicleId) || selectedVehicleId;
          selectedDeliveryId = selected.id;
        }
      }
      if (externalSelectionChanged && !externalSelectedId) selectedDeliveryId = null;
      updateVehicles();
      renderMarkers();
    },
    destroy() {
      range.removeEventListener('input', onRangeInput);
      range.removeEventListener('wheel', onRangeWheel);
      number.removeEventListener('input', onNumberInput);
      vehicleSelect.removeEventListener('change', onVehicleChange);
      canvas.removeEventListener('click', onCanvasClick);
    },
  };
}
