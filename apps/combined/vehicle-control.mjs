import { referenceIcon } from './reference-icons.mjs';
import { createOrderMap, createOrderMarker, orderMapModel } from './order-planning.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
import { vehicleOperations, sortVehicleOperations, resolveControlVehicle, resolveControlDelivery, vehicleEvents, deliveryRecords, controlPosition } from './vehicle-operations-model.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const count = (value, unit = '') => value === null || value === undefined ? '미확인' : `${value.toLocaleString('ko-KR')}${unit}`;
const labels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const factRows = facts => facts.length ? facts.map(fact => `<li><time>${esc(fact.time || '-')}</time><span>${esc(fact.message)}</span></li>`).join('') : '<li class="muted">기록된 사건이 없습니다.</li>';

export function mountVehicleControl({ element, onSelectVehicle, onSelectDelivery, onOpenNotice, onOpenManagement, onOpenRoute = () => {},
  mapFactory = createOrderMap, markerFactory = createOrderMarker,
  loadRouteData = () => fetch('/scenario/api/route-data').then(response => {
    if (!response.ok) throw new Error('배송지 위치를 불러오지 못했습니다.');
    return response.json();
  }),
}) {
  element.innerHTML = `<div class="vehicle-control-layout">
    <section class="panel control-fleet" aria-labelledby="control-fleet-heading">
      <div class="panel-heading"><h2 id="control-fleet-heading">차량별 남은 업무</h2><span data-control-count class="muted"></span></div>
      <div class="control-filters"><label class="field"><span>차량 검색</span><input type="search" data-control-search placeholder="차량번호 또는 배송원"></label><label class="field"><span>정렬</span><select data-control-sort><option value="received">주문 수신 순서<option value="stops">남은 배송지 많은 순<option value="boxes">남은 박스 많은 순<option value="duration">예상 소요 시간 긴 순</option></select></label></div>
      <p class="control-unit-note">배송 ID 기준 배송지 수입니다. 보류 배송지도 남은 업무에 포함합니다.</p>
      <div class="control-vehicle-columns" aria-hidden="true"><span>차량 / 배송원</span><span>배송지</span><span>박스</span><span>소요</span></div>
      <div class="control-vehicle-list" data-control-vehicles tabindex="0" aria-label="차량별 잔여량 비교"></div>
    </section>
    <section class="control-map-workspace" aria-label="선택 차량 운행">
      <div class="panel control-current" data-control-summary aria-live="polite"></div>
      <section class="panel control-map-panel" aria-labelledby="control-map-heading"><div class="panel-heading"><h2 id="control-map-heading">남은 배송지</h2><button type="button" class="button" data-control-support>${referenceIcon('support')}지원배차</button></div><div class="control-map-canvas" data-control-map></div><p class="control-map-note" data-control-map-note role="status"></p></section>
    </section>
    <aside class="panel control-details" aria-label="선택 차량 상세">
      <div class="panel-heading"><h2 data-control-detail-title>차량 상세</h2></div>
      <div class="detail-tabs control-tabs" role="tablist" aria-label="관제 관리"><button type="button" role="tab" id="tab-monitor" aria-selected="true" aria-controls="monitor-list-panel" data-control-tab="monitor">배송지 상세</button><button type="button" role="tab" id="tab-management" aria-selected="false" aria-controls="control-management-panel" tabindex="-1" data-control-tab="management">배송 관리</button></div>
      <section id="monitor-list-panel" role="tabpanel" aria-labelledby="tab-monitor"><p class="control-unit-note">배송지를 펼쳐 배송 정보와 요청사항을 확인하세요.</p><div data-control-stops class="control-stop-list"></div></section>
      <section id="control-management-panel" role="tabpanel" aria-labelledby="tab-management" hidden>
        <div data-control-records-view>
          <div class="control-management-target"><label class="field"><span>선택 배송지</span><select data-control-record-stop aria-label="관리할 배송지"></select></label><div class="control-management-actions"><button type="button" class="button subtle" data-control-compose>안내 작성</button><button type="button" class="button" data-control-route>배송 순서 관리</button></div></div>
          <p id="notice-send-status" class="route-message" role="status" hidden></p>
          <div class="control-record-filters" role="group" aria-label="기록 유형"><button type="button" data-control-record-filter="all" aria-pressed="true">전체</button><button type="button" data-control-record-filter="history" aria-pressed="false">처리 이력</button><button type="button" data-control-record-filter="notice" aria-pressed="false">고객 알림</button></div>
          <p class="control-unit-note">수신된 최근 기록을 시간순으로 표시합니다.</p><ol class="control-record-list" data-control-records tabindex="0" aria-label="선택 배송지 이력과 알림"></ol>
          <details class="control-common-events" data-control-common><summary>차량 공통 사건 이력</summary><p class="muted">대상 배송지가 지정되지 않은 최근 기록입니다.</p><ol class="control-fact-list" data-control-events></ol></details>
        </div>
        <div data-control-route-view hidden><div id="route-editor"></div></div>
      </section>
    </aside>
  </div>
  <dialog class="support-dispatch-dialog" data-support-dialog aria-labelledby="support-title"><div class="support-heading"><h2 id="support-title">지원배차</h2><button type="button" class="button icon-button" data-support-close aria-label="지원배차 닫기">${referenceIcon('close')}</button></div><p>예상 완료시간과 실제 완수 속도를 바탕으로 지원할 차량을 판단합니다.</p><p class="support-waiting">실제 위치가 연결되지 않아 주변 차량을 확인할 수 없습니다. 안정 레벨의 상·중·하 기준과 호출·수락·재배정 연결을 기다리고 있습니다.</p><div class="support-data" data-support-data></div><div class="support-actions"><button type="button" class="button" disabled>호출 대기</button><button type="button" class="button primary" disabled>지원 지시 대기</button></div></dialog>`;
  const find = selector => element.querySelector(selector);
  let data = null, rows = [], row = null, selectedId = null, sort = 'received', search = '';
  let previousVehicleId = null, previousSelectedId = null, recordFilter = 'all';
  let opened = new Set(), routeData = null, routePromise = null, map = null, markers = [], signature = '';
  let mapError = '', wheel, observer, destroyed = false;
  const mapElement = find('[data-control-map]');
  const list = find('[data-control-vehicles]');
  const stopList = find('[data-control-stops]');
  const support = find('[data-support-dialog]');
  const recordList = find('[data-control-records]');

  function replacePreservingFocus(target, markup, selector) {
    if (target.innerHTML === markup) return;
    const scroll = target.scrollTop;
    const focused = target.contains(document.activeElement) ? document.activeElement.closest(selector)?.getAttribute(selector.slice(1, -1)) : null;
    target.innerHTML = markup;
    target.scrollTop = scroll;
    if (focused) target.querySelector(`${selector.slice(0, -1)}="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function renderVehicles() {
    const visible = sortVehicleOperations(rows, sort).filter(item => `${item.vehicle.id} ${item.vehicle.plate} ${item.vehicle.driver}`.toLocaleLowerCase('ko-KR').includes(search));
    find('[data-control-count]').textContent = `${visible.length}대`;
    replacePreservingFocus(list, visible.map(item => `<button type="button" class="control-vehicle-row" data-control-vehicle="${esc(item.vehicle.id)}" aria-pressed="${item.vehicle.id === row?.vehicle.id}"><span><strong>${esc(item.vehicle.plate || item.vehicle.id)}</strong><small>${esc(item.vehicle.driver || '배송원 미등록')}</small></span><span aria-label="남은 배송지">${count(item.remainingStops)}</span><span aria-label="남은 박스">${count(item.remainingBoxes)}</span><span class="muted" aria-label="예상 소요 시간 미확인">미확인</span></button>`).join('') || '<p class="empty-state">조회 결과가 없습니다.</p>', '[data-control-vehicle]');
  }

  function renderSummary() {
    find('[data-control-summary]').innerHTML = row ? `<div class="panel-heading"><div><h2>${esc(row.vehicle.plate || row.vehicle.id)}</h2><p>${esc(row.vehicle.driver || '배송원 미등록')}</p></div><span class="badge">${row.vehicle.live ? '시뮬레이션' : '예시 배정'}</span></div><div class="control-workload"><div><span>남은 배송지</span><strong>${count(row.remainingStops, '곳')}</strong></div><div><span>남은 박스</span><strong>${count(row.remainingBoxes, '박스')}</strong></div><div><span>예상 소요 시간</span><strong>미확인</strong></div></div><dl class="control-running-facts"><div><dt>현재 배송지</dt><dd>${esc(row.current?.name || (row.remaining.length ? '출발 또는 배정 상태 확인' : '모든 배송 완료'))}</dd></div><div><dt>현재 도착 ETA</dt><dd>${esc(row.current?.preciseTimeText || row.current?.calculatedEta || '미확인')}</dd></div><div><dt>고정 출발 기준</dt><dd>${esc(row.vehicle.departure?.time || '미등록')}${row.vehicle.departure ? ' (시나리오)' : ''}</dd></div><div><dt>마지막 도착 ETA</dt><dd>${esc(row.lastArrivalEta || '미확인')}</dd></div><div><dt>전체 완료 예상</dt><dd>인도 완료 예측 미연결</dd></div><div><dt>보류 배송지</dt><dd>${count(row.heldStops, '곳')}</dd></div></dl>` : '<p class="empty-state">차량 데이터가 없습니다.</p>';
    find('[data-control-detail-title]').textContent = row ? `${row.vehicle.plate || row.vehicle.id} 상세` : '차량 상세';
  }

  function stopContents(stop) {
    return `<div class="control-stop-body"><p class="muted">${esc(stop.address || '주소 미등록')}</p><dl class="control-stop-facts"><div><dt>배정 박스</dt><dd>${count(stop.boxes, '박스')}</dd></div><div><dt>도착 ETA</dt><dd>${esc(stop.preciseTimeText || stop.calculatedEta || '미확인')}</dd></div></dl><section class="control-request"><h4>${referenceIcon('location')}고객 요청</h4><p>고객 요청 정보가 아직 수신되지 않았습니다.</p></section><section class="control-tip"><h4>배송원 팁</h4><p>${esc(stop.tip?.body || '등록된 배송팁이 없습니다.')}</p>${stop.tip ? `<small>${esc(stop.tip.author)} (${esc(stop.tip.updatedAt || '시각 미확인')})</small>` : ''}</section><button type="button" class="button control-open-records" data-control-manage="${esc(stop.id)}">이력·알림 보기</button></div>`;
  }

  function renderStops() {
    const markup = row?.deliveries.map(stop => `<details class="control-stop" data-control-stop="${esc(stop.id)}" ${opened.has(stop.id) ? 'open' : ''}><summary data-control-stop-summary="${esc(stop.id)}"><span class="control-stop-sequence">${esc(stop.sequence)}</span><strong>${esc(stop.name)}</strong><span class="badge ${stop.statusTone || ''}">${esc(labels[stop.status] || '미확인')}</span>${referenceIcon('expand')}</summary>${opened.has(stop.id) ? stopContents(stop) : ''}</details>`).join('') || '<p class="empty-state">배정된 배송지가 없습니다.</p>';
    replacePreservingFocus(stopList, markup, '[data-control-stop-summary]');
  }

  function showRecords() {
    find('[data-control-records-view]').hidden = false;
    find('[data-control-route-view]').hidden = true;
  }

  function renderRecords() {
    const stop = resolveControlDelivery(row, selectedId);
    const selector = find('[data-control-record-stop]');
    const options = row?.deliveries.map(item => `<option value="${esc(item.id)}">${esc(item.sequence)}. ${esc(item.name)} (${esc(labels[item.status] || '미확인')})</option>`).join('') || '<option value="">배정된 배송지 없음</option>';
    if (selector.innerHTML !== options) selector.innerHTML = options;
    selector.value = stop?.id || '';
    selector.disabled = !stop;
    find('[data-control-compose]').disabled = !stop || data.connected === false;
    find('[data-control-route]').disabled = !row?.deliveries.length;
    find('[data-control-common]').hidden = recordFilter === 'notice';
    element.querySelectorAll('[data-control-record-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.controlRecordFilter === recordFilter)));
    const expanded = [...recordList.querySelectorAll('[data-control-record-id][open]')].map(item => item.dataset.controlRecordId);
    const records = deliveryRecords(data, stop, recordFilter);
    const markup = records.map(record => `<li class="control-record" data-record-kind="${esc(record.kind)}"><time>${esc(record.time || '-')}</time>${record.kind === 'notice'
      ? `<details data-control-record-id="${esc(record.key)}"><summary data-control-record-key="${esc(record.key)}"><span class="control-record-kind">고객 알림</span><strong>${esc(record.title || '고객 안내')}</strong>${referenceIcon('expand')}</summary><p>${esc(record.body)}</p><small>${esc(record.status || '시연 기록')}</small></details>`
      : `<div><span class="control-record-kind">처리 이력</span><p>${esc(record.message)}</p></div>`}</li>`).join('') || '<li class="empty-state">표시할 기록이 없습니다.</li>';
    replacePreservingFocus(recordList, markup, '[data-control-record-key]');
    for (const id of expanded) recordList.querySelector(`[data-control-record-id="${CSS.escape(id)}"]`)?.setAttribute('open', '');
    find('[data-control-events]').innerHTML = factRows(vehicleEvents(data, row?.vehicle.id));
  }

  function renderSupport() {
    find('[data-support-data]').innerHTML = `<h3>수신 차량 원자료</h3><p class="muted">완수 속도는 실제 완료 사건의 시간 구간이 필요합니다. 현재 시뮬레이션 기록으로 실제 작업 속도를 산출하지 않습니다.</p><div class="support-table-scroll"><table><thead><tr><th>차량</th><th>완료 / 배정</th><th>마지막 도착 ETA</th><th>완료 예상</th><th>실제 완수 속도</th><th>안정 레벨</th></tr></thead><tbody>${rows.map(item => `<tr><th>${esc(item.vehicle.plate || item.vehicle.id)}</th><td>${item.completed.length} / ${item.deliveries.length}곳</td><td>${esc(item.lastArrivalEta || '미확인')}</td><td>미연결</td><td>실데이터 대기</td><td>기준 미정</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderMap() {
    if (!map) return;
    const model = orderMapModel(row?.remaining || [], routeData);
    const position = controlPosition(data, row);
    const nextSignature = JSON.stringify([row?.vehicle.id, model.mapped.map(item => [item.delivery.id, item.delivery.name, item.delivery.boxes, item.coordinates]), position]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      markers.splice(0).forEach(marker => marker.remove());
      markers = model.mapped.map(item => markerFactory(map, item.delivery, item.coordinates));
      if (position) {
        const markerElement = document.createElement('div');
        markerElement.className = 'control-map-vehicle';
        markerElement.setAttribute('role', 'img');
        markerElement.setAttribute('aria-label', position.label);
        markerElement.title = position.label;
        const vehicleMarker = new maplibregl.Marker({ element: markerElement }).setLngLat(position.coordinates).addTo(map);
        markers.push({ element: markerElement, remove: () => vehicleMarker.remove() });
      }
      const coords = [...model.mapped.map(item => item.coordinates), ...(position ? [position.coordinates] : [])];
      if (coords.length === 1) map.jumpTo({ center: coords[0], zoom: 13 });
      if (coords.length > 1) map.fitBounds([[Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))], [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))]], { padding: 52, maxZoom: 14, duration: 0 });
    }
    markers.forEach(marker => marker.element.setAttribute('aria-pressed', String(marker.element.dataset.orderMarker === selectedId)));
    find('[data-control-map-note]').textContent = mapError || (routeData
      ? `남은 배송지 ${model.mapped.length}곳 표시, 위치 미등록 ${model.unknownCount}곳. ${position ? '차량은 시뮬레이션 위치입니다. 실제 GPS 미연결.' : '차량 현재 위치 미수신.'}`
      : '배송지 위치 데이터를 불러오고 있습니다. 미등록 건수는 수신 후 확인합니다.');
  }

  function ensureMap() {
    if (mapError) return;
    if (!map) {
      try {
        map = mapFactory(mapElement);
        wheel = installModifierWheelZoom(map);
        observer = new ResizeObserver(() => map?.resize());
        observer.observe(mapElement);
      } catch {
        mapError = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
        find('[data-control-map-note]').textContent = mapError;
        return;
      }
    }
    map.resize();
    if (!routeData && !routePromise) routePromise = Promise.resolve().then(loadRouteData).then(value => {
      if (destroyed) return;
      if (!Array.isArray(value?.points)) throw new Error('배송지 위치 데이터 형식 오류');
      routeData = value; mapError = ''; renderMap();
    }).catch(() => {
      if (destroyed) return;
      mapError = '배송지 위치를 불러오지 못했습니다. 위치 미등록 여부를 확인할 수 없습니다. 새로고침해 다시 시도해 주세요.'; renderMap();
    }).finally(() => { routePromise = null; });
  }

  find('[data-control-search]').addEventListener('input', event => { search = event.target.value.trim().toLocaleLowerCase('ko-KR'); renderVehicles(); });
  find('[data-control-sort]').addEventListener('change', event => { sort = event.target.value; renderVehicles(); });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-control-vehicle]');
    if (button) onSelectVehicle(button.dataset.controlVehicle);
  });
  stopList.addEventListener('toggle', event => {
    if (!event.target.matches('[data-control-stop]') || !event.target.isConnected) return;
    const id = event.target.dataset.controlStop;
    if (event.target.open === opened.has(id)) return;
    if (event.target.open) { opened.add(id); onSelectDelivery(id); }
    else { opened.delete(id); renderStops(); }
  }, true);
  stopList.addEventListener('click', event => {
    const button = event.target.closest('[data-control-manage]');
    if (button) { showRecords(); onOpenManagement(button.dataset.controlManage); }
  });
  find('[data-control-record-stop]').addEventListener('change', event => onSelectDelivery(event.target.value));
  find('[data-control-compose]').addEventListener('click', () => onOpenNotice(find('[data-control-record-stop]').value));
  find('[data-control-route]').addEventListener('click', () => {
    find('[data-control-records-view]').hidden = true;
    find('[data-control-route-view]').hidden = false;
    onOpenRoute();
    find('[data-route-action="cancel"]')?.focus();
  });
  find('.control-record-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-control-record-filter]');
    if (!button) return;
    recordFilter = button.dataset.controlRecordFilter;
    renderRecords();
  });
  mapElement.addEventListener('click', event => {
    const marker = event.target.closest('[data-order-marker]');
    if (marker) onSelectDelivery(marker.dataset.orderMarker);
  });
  find('[data-control-support]').addEventListener('click', () => { renderSupport(); support.showModal(); });
  find('[data-support-close]').addEventListener('click', () => support.close());
  support.addEventListener('close', () => find('[data-control-support]').focus());

  return {
    showRecords,
    update(nextData, vehicleId, deliveryId) {
      data = nextData; rows = vehicleOperations(data); row = resolveControlVehicle(rows, vehicleId, deliveryId); selectedId = deliveryId;
      if (previousVehicleId !== row?.vehicle.id) { opened = new Set(); recordFilter = 'all'; showRecords(); }
      if (previousSelectedId !== deliveryId && row?.deliveries.some(stop => stop.id === deliveryId)) opened.add(deliveryId);
      const changedTarget = previousSelectedId !== deliveryId;
      previousVehicleId = row?.vehicle.id; previousSelectedId = deliveryId;
      renderVehicles(); renderSummary(); renderStops(); renderRecords(); ensureMap(); renderMap();
      if (changedTarget) recordList.scrollTop = 0;
      if (support.open) renderSupport();
      return row;
    },
    destroy() { destroyed = true; observer?.disconnect(); wheel?.remove(); markers.forEach(marker => marker.remove()); map?.remove(); },
  };
}
