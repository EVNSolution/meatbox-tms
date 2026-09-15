import { referenceIcon } from './reference-icons.mjs';
const ORDER_POSITIONS = [[18, 24], [34, 63], [47, 38], [60, 72], [69, 21], [78, 51], [26, 81], [52, 12]];
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

export function mountOrderPlanning({ element, onSelect = () => {} }) {
  if (!element) throw new TypeError('주문 배차 영역이 필요합니다.');
  element.innerHTML = `
    <section class="order-map-panel" aria-labelledby="order-map-heading">
      <div class="order-map-heading"><div><h2 id="order-map-heading">주문 배차 지도</h2><p>권역별 주문과 배차 차량</p></div><span class="order-map-count" data-order-map-count>0건</span></div>
      <div class="order-map-canvas" data-order-map-canvas aria-label="주문 위치">
        <div class="order-map-layer" data-order-map-layer></div>
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
  let sceneSignature = '';
  let visibleDeliveries = [];
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
    visibleDeliveries = vehicleDeliveries.slice(0, ORDER_POSITIONS.length);
    if (!visibleDeliveries.some(delivery => delivery.id === selectedDeliveryId)) selectedDeliveryId = null;
    const nextSignature = visibleDeliveries.map(delivery => `${delivery.id}:${delivery.name}:${delivery.boxes}`).join('|');
    if (nextSignature !== sceneSignature) {
      sceneSignature = nextSignature;
      const orders = visibleDeliveries.map((delivery, index) => {
        const [top, left] = ORDER_POSITIONS[index];
        return `<button type="button" class="order-map-marker" data-order-marker="${escapeHtml(delivery.id)}" style="--marker-top:${top}%;--marker-left:${left}%" aria-label="${escapeHtml(delivery.name || delivery.id)} ${boxesText(delivery.boxes)} 선택"></button>`;
      }).join('');
      layer.innerHTML = `<div class="order-marker-layer">${orders}</div>`;
    }
    layer.querySelectorAll('[data-order-marker]').forEach(marker => marker.setAttribute('aria-pressed', String(marker.dataset.orderMarker === selectedDeliveryId)));
    count.textContent = visibleDeliveries.length === vehicleDeliveries.length ? `${vehicleDeliveries.length}건` : `지도 ${visibleDeliveries.length} / ${vehicleDeliveries.length}건`;
    updateSelection();
    syncControls();
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
  listen(vehicleSelect, 'change', event => { selectedVehicleId = event.target.value; selectedDeliveryId = null; sceneSignature = ''; renderScene(); });
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
      updateVehicles(); renderScene();
    },
    destroy() { listeners.splice(0).forEach(remove => remove()); },
  };
}
