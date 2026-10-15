import { referenceIcon } from './reference-icons.mjs';
import { fitIcon } from './account-icons.mjs';
import { renderCustomerRequests } from './customer-requests.mjs';
import { createOrderMap, createOrderMarker, orderMapModel } from '../src/shared/maps/order-map.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';
import { locationLabel, plateLabel } from './vehicle-identity.mjs';
import { vehicleOperations, sortVehicleOperations, resolveDefaultControlVehicle, resolveControlDelivery, vehicleEvents, deliveryRecords, controlPosition } from './vehicle-operations-model.mjs';
import { driverToolsMarkup, mountDriverTools } from './driver-tools.ts';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const count = (value, unit = '') => value === null || value === undefined ? '미확인' : `${value.toLocaleString('ko-KR')}${unit}`;
const labels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const durationText = minutes => Number.isFinite(minutes) ? `${minutes}분` : '미확인';
const clockText = value => {
  if (!Number.isFinite(value)) return '미확인';
  const minutes = Math.round(value / 60000), days = Math.floor(minutes / 1440);
  return `${days === 1 ? '다음날 ' : days > 1 ? `+${days}일 ` : ''}${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const completionText = row => row.heldStops ? `보류 ${row.heldStops}곳, 미확인`
  : row.completionText ? row.completionText
  : Number.isFinite(row.timing?.completionMs) ? `${clockText(row.timing.completionMs)}${row.timing.completed ? ' 완료' : ' 예상'}` : '미확인';
const remainingText = row => `${row.heldStops && Number.isFinite(row.remainingMinutes) ? '보류 제외 ' : ''}${durationText(row.remainingMinutes)}`;
const actualSpeedText = row => row.actualSpeed
  ? `${row.actualSpeed.completedStops}곳 / ${row.actualSpeed.elapsedMinutes}분`
  : '산정 대기';

const factRows = facts => facts.length ? facts.map(fact => `<li><time>${esc(fact.time || '-')}</time><span>${esc(fact.message)}</span></li>`).join('') : '<li class="muted">미등록</li>';

export function mountVehicleControl({ element, onSelectVehicle, onSelectDelivery, onOpenManagement, onOpenRoute = () => {},
  mapFactory = createOrderMap, markerFactory = createOrderMarker,
  loadRouteData = null,
}) {
  element.innerHTML = `<div class="vehicle-control-layout">
    <section class="panel control-fleet" aria-labelledby="control-fleet-heading">
      <div class="panel-heading"><h2 id="control-fleet-heading">차량별 남은 업무</h2><span data-control-count class="muted"></span></div>
      <div class="control-filters"><label class="field"><span>차량 검색</span><input type="search" data-control-search placeholder="차량번호 또는 배송원"></label><label class="field"><span>정렬</span><select data-control-sort><option value="received">주문 수신 순서<option value="stops">남은 배송지 많은 순<option value="boxes">남은 박스 많은 순<option value="duration">예상 소요 시간 긴 순</option></select></label></div>
      <div class="control-vehicle-columns" aria-hidden="true"><span>차량 / 배송원</span><span>배송지</span><span>박스</span><span>소요</span></div>
      <div class="control-vehicle-list" data-control-vehicles tabindex="0" aria-label="차량별 잔여량 비교"></div>
    </section>
    <section class="control-map-workspace" aria-label="선택 차량 운행">
      <div class="panel control-current" data-control-summary aria-live="polite"></div>
      <section class="panel control-map-panel" aria-labelledby="control-map-heading"><h2 id="control-map-heading" class="sr-only">남은 배송지</h2><div class="control-map-canvas" data-control-map></div><div class="control-map-tools"><button type="button" class="button" data-control-fit>${fitIcon}전체 보기</button><button type="button" class="button" data-control-support>${referenceIcon('support')}지원배차</button></div><p class="control-map-note" data-control-map-note role="status"></p></section>
    </section>
    <aside class="panel control-details" aria-label="선택 차량 상세">
      <div class="panel-heading"><h2 data-control-detail-title>차량 상세</h2></div>
      ${driverToolsMarkup()}
      <div class="detail-tabs control-tabs" role="tablist" aria-label="관제 관리"><button type="button" role="tab" id="tab-monitor" aria-selected="true" aria-controls="monitor-list-panel" data-control-tab="monitor">배송지 상세</button><button type="button" role="tab" id="tab-management" aria-selected="false" aria-controls="control-management-panel" tabindex="-1" data-control-tab="management">배송 관리</button></div>
      <section id="monitor-list-panel" role="tabpanel" aria-labelledby="tab-monitor"><div data-control-stops class="control-stop-list"></div></section>
      <section id="control-management-panel" role="tabpanel" aria-labelledby="tab-management" hidden>
        <div data-control-records-view>
          <div class="control-management-target"><label class="field"><span>선택 배송지</span><select data-control-record-stop aria-label="관리할 배송지"></select></label><div class="control-management-actions"><button type="button" class="button" data-control-route>배송 순서 관리</button></div></div>
          <div class="control-record-filters" role="group" aria-label="기록 유형"><button type="button" data-control-record-filter="all" aria-pressed="true">전체</button><button type="button" data-control-record-filter="history" aria-pressed="false">처리 이력</button><button type="button" data-control-record-filter="notice" aria-pressed="false">고객 알림</button></div>
          <ol class="control-record-list" data-control-records tabindex="0" aria-label="선택 배송지 이력과 알림"></ol>
          <details class="control-common-events" data-control-common><summary>차량 공통 사건 이력</summary><ol class="control-fact-list" data-control-events></ol></details>
        </div>
        <div data-control-route-view hidden><div id="route-editor"></div></div>
      </section>
    </aside>
  </div>
  <dialog class="support-dispatch-dialog" data-support-dialog aria-labelledby="support-title"><div class="support-heading"><h2 id="support-title">지원배차</h2><button type="button" class="button icon-button" data-support-close aria-label="지원배차 닫기">${referenceIcon('close')}</button></div><p>예상 완료시간과 실제 완수 속도를 바탕으로 지원할 차량을 판단합니다.</p><p class="support-waiting">실제 위치가 연결되지 않아 주변 차량을 확인할 수 없습니다. 안정 레벨의 상, 중, 하 기준과 호출, 수락, 재배정 연결을 기다리고 있습니다.</p><div class="support-data" data-support-data></div><div class="support-actions"><button type="button" class="button" disabled>호출 대기</button><button type="button" class="button primary" disabled>지원 지시 대기</button></div></dialog>`;
  const find = selector => element.querySelector(selector);
  let data = null, rows = [], row = null, selectedId = null, sort = 'received', search = '';
  let previousVehicleId = null, previousSelectedId = null, recordFilter = 'all';
  let opened = new Set(), routeData = null, routePromise = null, map = null, markers = [], signature = '';
  let mapError = '', wheel, observer, destroyed = false, routeEpoch = 0, factsOpen = false, fitCoords = [], fitAllCoords = [];
  const mapElement = find('[data-control-map]');
  const list = find('[data-control-vehicles]');
  const stopList = find('[data-control-stops]');
  const support = find('[data-support-dialog]');
  const recordList = find('[data-control-records]');
  const driverTools = mountDriverTools({ element });

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
    replacePreservingFocus(list, visible.map(item => `<button type="button" class="control-vehicle-row" data-control-vehicle="${esc(item.vehicle.id)}" aria-pressed="${item.vehicle.id === row?.vehicle.id}"><span><strong>${esc(item.vehicle.driver || '배송원 미등록')}</strong><small>${esc(plateLabel(item.vehicle))}</small></span><span aria-label="남은 배송지">${count(item.remainingStops)}</span><span aria-label="남은 박스">${count(item.remainingBoxes)}</span><span class="muted" aria-label="${esc(`예상 소요 시간 ${remainingText(item)}`)}">${esc(remainingText(item))}</span></button>`).join('') || '<p class="control-unit-note">검색 결과 없음</p>', '[data-control-vehicle]');
  }

  function renderSummary() {
    const source = Boolean(data?.sourceData);
    find('[data-control-summary]').innerHTML = row ? `<div class="panel-heading"><div><h2>${esc(row.vehicle.driver || '배송원 미등록')}</h2><p>${esc(plateLabel(row.vehicle))}</p></div><span class="badge">${source ? '운영 현황' : row.vehicle.live ? '시뮬레이션' : '예시 배정'}</span></div><div class="control-workload"><div><span>남은 배송지</span><strong>${count(row.remainingStops, '곳')}</strong></div><div><span>남은 박스</span><strong>${count(row.remainingBoxes, '박스')}</strong></div><div><span>예상 소요 시간</span><strong>${esc(remainingText(row))}</strong></div></div><details class="control-running-details"${factsOpen ? ' open' : ''}><summary>운행 상세<span>${esc(row.current?.name ? `현재 ${row.current.name}, ETA ${row.current.preciseTimeText || row.current.calculatedEta || '미확인'}` : '현재 배송지 없음')}</span>${referenceIcon('next')}</summary><dl class="control-running-facts"><div><dt>현재 배송지</dt><dd>${esc(row.current?.name || (row.remaining.length ? '출발 또는 배정 상태 확인' : '모든 배송 완료'))}</dd></div><div><dt>현재 도착 ETA</dt><dd>${esc(row.current?.preciseTimeText || row.current?.calculatedEta || '미확인')}</dd></div><div><dt>고정 출발 기준</dt><dd>${esc(row.fixedDepartureText || '미등록')}${row.vehicle.departure && !source ? ' (시나리오)' : ''}</dd></div><div><dt>마지막 도착 ETA</dt><dd>${esc(row.lastArrivalEta || '미확인')}</dd></div><div><dt>전체 인도 완료</dt><dd>${esc(completionText(row))}</dd></div><div><dt>보류 배송지</dt><dd>${count(row.heldStops, '곳')}</dd></div></dl>${source ? `<p class="muted control-timing-note">${esc(data.sourceData.date || '기준일')} 승인 운영 계획 추정치입니다. 실시간 GPS와 도로 ETA는 연결되지 않았습니다.</p>` : row.timing ? '<p class="muted control-timing-note">기존 이동과 하차 시간으로 계산한 시뮬레이션 예측입니다. 보류 배송이 있는 차량은 완료 예측에서 제외합니다.</p>' : ''}</details>` : '<p class="control-unit-note">미배정</p>';
    find('[data-control-detail-title]').textContent = row ? `${row.vehicle.driver || row.vehicle.id} 상세` : '차량 상세';
  }

  function renderEmptySummary(empty, message) {
    const quantity = empty ? 0 : null;
    find('[data-control-summary]').innerHTML = `<div class="panel-heading"><div><h2>운행 정보</h2>${empty ? '' : `<p>${esc(message)}</p>`}</div><span class="badge">${empty ? '배차 대기' : '자료 확인 중'}</span></div><div class="control-workload"><div><span>남은 배송지</span><strong>${count(quantity, '곳')}</strong></div><div><span>남은 박스</span><strong>${count(quantity, '박스')}</strong></div><div><span>예상 소요 시간</span><strong>미확인</strong></div></div><details class="control-running-details"${factsOpen ? ' open' : ''}><summary>운행 상세<span>${empty ? '배차 대기' : '자료 확인 중'}</span>${referenceIcon('next')}</summary><dl class="control-running-facts"><div><dt>현재 배송지</dt><dd>${empty ? '미배정' : '미확인'}</dd></div><div><dt>현재 도착 ETA</dt><dd>미확인</dd></div><div><dt>고정 출발 기준</dt><dd>미확인</dd></div><div><dt>마지막 도착 ETA</dt><dd>미확인</dd></div><div><dt>전체 인도 완료</dt><dd>미확인</dd></div><div><dt>보류 배송지</dt><dd>${count(quantity, '곳')}</dd></div></dl></details>`;
    find('[data-control-detail-title]').textContent = '차량 상세';
  }

  function stopContents(stop) {
    return `<div class="control-stop-body"><p class="muted">${esc(stop.address || '주소 미등록')}</p><dl class="control-stop-facts"><div><dt>배정 박스</dt><dd>${count(stop.boxes, '박스')}</dd></div><div><dt>도착 ETA</dt><dd>${esc(stop.preciseTimeText || stop.calculatedEta || '미확인')}</dd></div></dl><section class="control-request">${renderCustomerRequests(stop)}</section><section class="control-tip"><h4>배송원 팁</h4><p>${esc(stop.tip?.body || '등록된 배송팁이 없습니다.')}</p>${stop.tip ? `<small>${esc(stop.tip.author)}${stop.tip.updatedAt ? ` (${esc(stop.tip.updatedAt)})` : ''}</small>` : ''}</section><button type="button" class="button control-open-records" data-control-manage="${esc(stop.id)}">기록 보기</button></div>`;
  }

  function renderStops() {
    const markup = row?.deliveries.map(stop => `<details class="control-stop" data-control-stop="${esc(stop.id)}" ${opened.has(stop.id) ? 'open' : ''}><summary data-control-stop-summary="${esc(stop.id)}"><span class="control-stop-sequence">${esc(stop.sequence)}</span><strong>${esc(stop.name)}</strong><span class="badge ${stop.statusTone || ''}">${esc(labels[stop.status] || '미확인')}</span>${referenceIcon('expand')}</summary>${opened.has(stop.id) ? stopContents(stop) : ''}</details>`).join('') || '<p class="control-unit-note">미배정</p>';
    replacePreservingFocus(stopList, markup, '[data-control-stop-summary]');
  }

  function showRecords() {
    find('[data-control-records-view]').hidden = false;
    find('[data-control-route-view]').hidden = true;
  }

  function renderRecords() {
    const source = Boolean(data?.sourceData);
    const stop = resolveControlDelivery(row, selectedId);
    const selector = find('[data-control-record-stop]');
    const options = row?.deliveries.map(item => `<option value="${esc(item.id)}">${esc(item.sequence)}. ${esc(item.name)} (${esc(labels[item.status] || '미확인')})</option>`).join('') || '<option value="">배정된 배송지 없음</option>';
    if (selector.innerHTML !== options) selector.innerHTML = options;
    selector.value = stop?.id || '';
    selector.disabled = !stop;
    find('[data-control-route]').disabled = !row?.deliveries.length || Boolean(data?.dispatch?.readOnly);
    find('[data-control-common]').hidden = recordFilter === 'notice';
    element.querySelectorAll('[data-control-record-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.controlRecordFilter === recordFilter)));
    const expanded = [...recordList.querySelectorAll('[data-control-record-id][open]')].map(item => item.dataset.controlRecordId);
    const records = deliveryRecords(data, stop, recordFilter);
    const markup = records.map(record => `<li class="control-record" data-record-kind="${esc(record.kind)}"><time>${esc(record.time || '-')}</time>${record.kind === 'notice'
      ? `<details data-control-record-id="${esc(record.key)}"><summary data-control-record-key="${esc(record.key)}"><span class="control-record-kind">고객 알림</span><strong>${esc(record.title || '고객 안내')}</strong>${referenceIcon('expand')}</summary><p>${esc(record.body)}</p><small>${esc(record.status || (source ? '처리 기록' : '시연 기록'))}</small></details>`
      : `<div><span class="control-record-kind">처리 이력</span><p>${esc(record.message)}</p></div>`}</li>`).join('') || '<li class="muted">미등록</li>';
    replacePreservingFocus(recordList, markup, '[data-control-record-key]');
    for (const id of expanded) recordList.querySelector(`[data-control-record-id="${CSS.escape(id)}"]`)?.setAttribute('open', '');
    find('[data-control-events]').innerHTML = factRows(vehicleEvents(data, row?.vehicle.id));
  }

  function renderSupport() {
    const source = Boolean(data?.sourceData);
    find('[data-support-data]').innerHTML = `<h3>차량 운영 현황</h3><p class="muted">${source ? '승인 운영 계획과 수신된 실제 완료 기록을 표시합니다. GPS 기반 주변 차량 비교는 산정 대기 중입니다.' : '완수 속도는 실제 완료 사건의 시간 구간이 필요합니다. 현재 시뮬레이션 기록으로 실제 작업 속도를 산출하지 않습니다.'}</p><div class="support-table-scroll"><table><thead><tr><th>배송원</th><th>완료 / 배정</th><th>계획 출발</th><th>마지막 도착 ETA</th><th>완료 예상</th><th>실제 완수 속도</th><th>안정 레벨</th></tr></thead><tbody>${rows.map(item => `<tr><th>${esc(item.vehicle.driver || item.vehicle.id)}</th><td>${item.completed.length} / ${item.deliveries.length}곳</td><td>${esc(item.fixedDepartureText || '미확인')}</td><td>${esc(item.lastArrivalEta || '미확인')}</td><td>${esc(completionText(item))}${item.timing ? `<small>${source ? '승인 운영계획' : '시뮬레이션 계산값'}</small>` : ''}</td><td>${source ? esc(actualSpeedText(item)) : '실데이터 대기'}</td><td>기준 미정</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderMap() {
    if (!map) return;
    const source = Boolean(data?.sourceData);
    const activeRouteData = source ? { points: (row?.remaining || []).flatMap(delivery =>
      Array.isArray(delivery.coordinates) && delivery.coordinates.length === 2 && delivery.coordinates.every(Number.isFinite)
        ? [{ id: delivery.id, lng: delivery.coordinates[0], lat: delivery.coordinates[1] }] : []) } : routeData;
    const model = orderMapModel(row?.remaining || [], activeRouteData);
    const rawPosition = controlPosition(data, row);
    // controlPosition() keeps vehicle-operations-model.mjs's own historical, byte-pinned label text
    // (see test/web-fork-legacy); only its 'demo' branch needs the unverified disclosure the marker shows.
    const position = rawPosition?.source === 'demo' ? { ...rawPosition, label: locationLabel(row.vehicle) } : rawPosition;
    const nextSignature = JSON.stringify([row?.vehicle.id, model.mapped.map(item => [item.delivery.id, item.delivery.name, item.delivery.boxes, item.coordinates]), position]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      markers.splice(0).forEach(marker => marker.remove());
      markers = model.mapped.map(item => {
        const marker = markerFactory(map, item.delivery, item.coordinates);
        // The control map shows the visit order inside the pin; the shared pin builder stays untouched.
        if (Number.isFinite(item.delivery.sequence) && marker.element?.classList) {
          marker.element.classList.add('order-map-marker-numbered');
          marker.element.textContent = String(item.delivery.sequence);
        }
        return marker;
      });
      if (position) {
        const markerElement = document.createElement('div');
        markerElement.className = 'control-map-vehicle';
        markerElement.setAttribute('role', 'img');
        markerElement.setAttribute('aria-label', position.label);
        markerElement.title = position.label;
        const vehicleMarker = new maplibregl.Marker({ element: markerElement }).setLngLat(position.coordinates).addTo(map);
        markers.push({ element: markerElement, remove: () => vehicleMarker.remove() });
      }
      fitCoords = model.mapped.map(item => item.coordinates);
      fitAllCoords = [...fitCoords, ...(position ? [position.coordinates] : [])];
      if (!fitCoords.length) fitCoords = fitAllCoords;
      fitView();
    }
    markers.forEach(marker => marker.element.setAttribute('aria-pressed', String(marker.element.dataset.orderMarker === selectedId)));
    { const note = find('[data-control-map-note]'); if (note.dataset) { note.dataset.error = String(Boolean(mapError)); note.dataset.empty = 'false'; } }
    find('[data-control-map-note]').textContent = mapError || (activeRouteData
      ? `남은 배송지 ${model.mapped.length}곳 표시, 위치 미등록 ${model.unknownCount}곳. ${position ? source ? '차량 기준 위치 표시. 실시간 GPS 미수신.' : '차량은 시뮬레이션 위치입니다. 실제 GPS 미연결.' : '차량 현재 위치 미수신.'}`
      : '배송지 위치 데이터를 불러오고 있습니다. 미등록 건수는 수신 후 확인합니다.');
  }

  // Floating cards over the map (desktop) count as padding so the stops center in the free area.
  function mapPadding() {
    const pad = { top: 24, right: 24, bottom: 24, left: 24 };
    const canvas = mapElement.getBoundingClientRect?.();
    if (!canvas || typeof getComputedStyle !== 'function') return pad;
    for (const node of [find('[data-control-summary]'), find('[data-control-map-note]')]) {
      if (!node?.getBoundingClientRect || getComputedStyle(node).position !== 'absolute') continue;
      const rect = node.getBoundingClientRect();
      if (!rect.height || rect.bottom <= canvas.top || rect.top >= canvas.bottom) continue;
      if (rect.top - canvas.top < canvas.bottom - rect.bottom) pad.top = Math.max(pad.top, rect.bottom - canvas.top + 16);
      else pad.bottom = Math.max(pad.bottom, canvas.bottom - rect.top + 16);
    }
    if (pad.top + pad.bottom > canvas.height - 120) return { top: 24, right: 24, bottom: 24, left: 24 };
    return pad;
  }
  // Default view frames the stops; the button also frames the vehicle, which can sit far from them.
  function fitView(coords = fitCoords) {
    if (!map || !coords.length) return;
    const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: mapPadding(), maxZoom: coords.length === 1 ? 13 : 14, duration: 0 });
  }

  function createMap() {
    if (mapError || map) return;
    try {
      map = mapFactory(mapElement);
      wheel = installModifierWheelZoom(map);
      observer = new ResizeObserver(() => { map?.resize(); fitView(); });
      observer.observe(mapElement);
    } catch {
      mapError = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
      find('[data-control-map-note]').textContent = mapError;
      if (find('[data-control-map-note]').dataset) find('[data-control-map-note]').dataset.error = 'true';
    }
  }

  // Without work the map still shows, empty, with the reason in a chip over it.
  function resetMap() {
    routeEpoch += 1;
    markers.splice(0).forEach(marker => marker.remove());
    signature = ''; fitCoords = []; fitAllCoords = [];
    createMap();
  }

  function ensureMap() {
    if (mapError) return;
    createMap();
    if (!map) return;
    map.resize();
    if (data?.sourceData) return;
    if (typeof loadRouteData !== 'function') {
      routeData = { points: [] };
      renderMap();
      return;
    }
    if (!routeData && !routePromise) {
      const requestEpoch = routeEpoch;
      const request = Promise.resolve().then(loadRouteData).then(value => {
        if (destroyed || requestEpoch !== routeEpoch) return;
        if (!Array.isArray(value?.points)) throw new Error('배송지 위치 데이터 형식 오류');
        routeData = value; mapError = ''; renderMap();
      }).catch(() => {
        if (destroyed || requestEpoch !== routeEpoch) return;
        mapError = '배송지 위치를 불러오지 못했습니다. 위치 미등록 여부를 확인할 수 없습니다. 새로고침해 다시 시도해 주세요.'; renderMap();
      }).finally(() => { if (routePromise === request) routePromise = null; });
      routePromise = request;
    }
  }

  function removeMap() {
    routeEpoch += 1;
    observer?.disconnect();
    wheel?.remove();
    markers.splice(0).forEach(marker => marker.remove());
    map?.remove();
    observer = undefined; wheel = undefined; map = null; signature = '';
  }

  function setControlsDisabled(disabled) {
    find('[data-control-search]').disabled = disabled;
    find('[data-control-sort]').disabled = disabled;
    find('[data-control-support]').disabled = disabled || !row;
    find('[data-control-record-stop]').disabled = disabled || !row;
    find('[data-control-route]').disabled = disabled || !row?.deliveries.length;
    element.querySelectorAll('[data-control-record-filter]').forEach(button => { button.disabled = disabled; });
  }

  function clear({ empty = false, message = '배송 자료를 확인하고 있습니다.' } = {}) {
    driverTools.update(null, null);
    data = null; rows = []; row = null; selectedId = null;
    previousVehicleId = null; previousSelectedId = null;
    search = ''; sort = 'received'; opened = new Set(); recordFilter = 'all';
    routeData = null; routePromise = null; mapError = '';
    find('[data-control-search]').value = '';
    find('[data-control-sort]').value = 'received';
    if (support.open) support.close();
    showRecords();
    resetMap();
    find('[data-control-count]').textContent = empty ? '0대' : '미확인';
    list.innerHTML = `<p class="control-unit-note">${empty ? '미배정' : '미확인'}</p>`;
    renderEmptySummary(empty, message);
    stopList.innerHTML = `<p class="control-unit-note">${empty ? '미배정' : '미확인'}</p>`;
    find('[data-control-record-stop]').innerHTML = `<option value="">${empty ? '배정된 배송지 없음' : '배송 자료 미확인'}</option>`;
    find('[data-control-record-stop]').value = '';
    recordList.innerHTML = `<li class="muted">${empty ? '미등록' : '미확인'}</li>`;
    find('[data-control-events]').innerHTML = empty ? factRows([]) : '<li class="muted">미확인</li>';
    find('[data-support-data]').innerHTML = '';
    find('[data-control-common]').hidden = false;
    element.querySelectorAll('[data-control-record-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.controlRecordFilter === 'all')));
    const note = find('[data-control-map-note]');
    note.textContent = mapError || message;
    if (note.dataset) note.dataset.empty = 'true';
    setControlsDisabled(true);
  }

  find('[data-control-summary]').addEventListener('toggle', event => { factsOpen = event.target.open; fitView(); }, true);
  find('[data-control-search]').addEventListener('input', event => { if (!data) return; search = event.target.value.trim().toLocaleLowerCase('ko-KR'); renderVehicles(); });
  find('[data-control-sort]').addEventListener('change', event => { if (!data) return; sort = event.target.value; renderVehicles(); });
  list.addEventListener('click', event => {
    if (!data) return;
    const button = event.target.closest('[data-control-vehicle]');
    if (button) onSelectVehicle(button.dataset.controlVehicle);
  });
  stopList.addEventListener('toggle', event => {
    if (!data) return;
    if (!event.target.matches('[data-control-stop]') || !event.target.isConnected) return;
    const id = event.target.dataset.controlStop;
    if (event.target.open === opened.has(id)) return;
    if (event.target.open) { opened.add(id); onSelectDelivery(id); }
    else { opened.delete(id); renderStops(); }
  }, true);
  stopList.addEventListener('click', event => {
    if (!data) return;
    const button = event.target.closest('[data-control-manage]');
    if (button) { showRecords(); onOpenManagement(button.dataset.controlManage); }
  });
  find('[data-control-record-stop]').addEventListener('change', event => { if (data && event.target.value) onSelectDelivery(event.target.value); });
  find('[data-control-route]').addEventListener('click', () => {
    if (!data || !row?.deliveries.length) return;
    find('[data-control-records-view]').hidden = true;
    find('[data-control-route-view]').hidden = false;
    onOpenRoute();
    find('[data-route-action="cancel"]')?.focus();
  });
  find('.control-record-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-control-record-filter]');
    if (!button || !data) return;
    recordFilter = button.dataset.controlRecordFilter;
    renderRecords();
  });
  mapElement.addEventListener('click', event => {
    if (!data) return;
    const marker = event.target.closest('[data-order-marker]');
    if (marker) onSelectDelivery(marker.dataset.orderMarker);
  });
  find('[data-control-fit]').addEventListener('click', () => fitView(fitAllCoords));
  find('[data-control-support]').addEventListener('click', () => { if (!data || !row) return; renderSupport(); support.showModal(); });
  find('[data-support-close]').addEventListener('click', () => support.close());
  support.addEventListener('close', () => find('[data-control-support]').focus());

  return {
    showRecords,
    clear,
    update(nextData, vehicleId, deliveryId) {
      if (!nextData) { clear(); return null; }
      data = nextData; rows = vehicleOperations(data).filter(item => !data.dispatch || item.deliveries.length);
      if (!rows.length) { clear({ empty: true, message: '확정된 배차가 없습니다.' }); return null; }
      const preferredDeliveryId = deliveryId ?? data?.sourceData?.defaultStopId;
      row = resolveDefaultControlVehicle(data, rows, vehicleId, preferredDeliveryId); selectedId = preferredDeliveryId;
      driverTools.update(data, row);
      if (!map) mapElement.innerHTML = '';
      setControlsDisabled(false);
      if (previousVehicleId !== row?.vehicle.id) { opened = new Set(); recordFilter = 'all'; showRecords(); }
      if (previousSelectedId !== deliveryId && row?.deliveries.some(stop => stop.id === deliveryId)) opened.add(deliveryId);
      const changedTarget = previousSelectedId !== deliveryId;
      previousVehicleId = row?.vehicle.id; previousSelectedId = deliveryId;
      renderVehicles(); renderSummary(); renderStops(); renderRecords(); ensureMap(); renderMap();
      if (changedTarget) recordList.scrollTop = 0;
      if (support.open) renderSupport();
      return row;
    },
    destroy() { destroyed = true; driverTools.destroy(); if (support.open) support.close(); removeMap(); },
  };
}
