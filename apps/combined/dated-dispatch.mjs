import { mountDatePicker } from './date-picker.mjs';
import { mountOrderPlanning } from './order-planning.mjs';
import { referenceIcon } from './reference-icons.mjs';
import { createDispatchFleet } from './dispatch-assignment.mjs';
import { mountDispatchWorkflow } from './dispatch-workflow.mjs';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function adaptDispatchDay(day, regions) {
  if (day?.schemaVersion !== 1 || !datePattern.test(day.date) || !Array.isArray(day.orders) || !Array.isArray(day.groups)) throw new TypeError('배차 정보 형식이 올바르지 않습니다.');
  const groups = new Map(day.groups.map(group => [group.id, group]));
  const ids = new Set();
  let boxes = 0;
  for (const order of day.orders) {
    if (!order.id || ids.has(order.id) || !groups.has(order.groupId) || !Number.isFinite(order.boxes) || order.boxes < 0 || !Array.isArray(order.zoneIds)) throw new TypeError('주문 자료를 확인해 주세요.');
    if (order.coordinates !== null && (!Array.isArray(order.coordinates) || order.coordinates.length !== 2 || !order.coordinates.every(Number.isFinite) || Math.abs(order.coordinates[0]) > 180 || Math.abs(order.coordinates[1]) > 90)) throw new TypeError('주문 좌표를 확인해 주세요.');
    ids.add(order.id); boxes += order.boxes;
  }
  if (day.summary?.orders !== day.orders.length || !Number.isFinite(day.summary?.boxes) || Math.abs(boxes - day.summary.boxes) > 0.00001) throw new TypeError('주문 합계가 일치하지 않습니다.');
  if (regions?.type !== 'FeatureCollection' || !Array.isArray(regions.features)) throw new TypeError('권역 자료 형식이 올바르지 않습니다.');
  return {
    dispatchSource: day,
    dispatchRegions: regions,
    fleetVehicles: createDispatchFleet(day),
    fleetDeliveries: day.orders.map(order => ({ ...order, vehicleId: null, driver: '', status: 'unassigned' })),
  };
}

export function resolveDispatchDate(manifest, requested) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.dates) || !manifest.dates.length) throw new TypeError('날짜 목록이 비어 있습니다.');
  const dates = manifest.dates.map(item => item.date);
  if (dates.some(date => !datePattern.test(date)) || new Set(dates).size !== dates.length || !dates.includes(manifest.defaultDate)) throw new TypeError('날짜 목록이 올바르지 않습니다.');
  return dates.includes(requested) ? requested : manifest.defaultDate;
}

export function mountDatedDispatch({ element, onSelect, onAssign, onCommand, onDateChange, onContextChange = () => {}, fetchJSON = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) { const error = new Error('자료를 불러오지 못했습니다.'); error.status = response.status; throw error; }
  return response.json();
}, planningFactory = mountOrderPlanning, datePickerFactory = mountDatePicker, workflowFactory = mountDispatchWorkflow }) {
  element.innerHTML = `<section class="dispatch-date-toolbar" data-dispatch-toolbar hidden aria-label="배차 날짜"><div class="dispatch-date-picker"><span>배차일</span><button type="button" class="button subtle" data-dispatch-prev aria-label="이전 배차일">${referenceIcon('next')}</button><div data-dispatch-date></div><button type="button" class="button subtle" data-dispatch-next aria-label="다음 배차일">${referenceIcon('next')}</button></div></section><p class="dispatch-data-message" data-dispatch-status role="status">배차 정보를 확인하고 있습니다.</p><button type="button" class="button" data-dispatch-retry hidden>다시 불러오기</button><div data-dispatch-workflow hidden></div><div data-dispatch-planning hidden></div>`;
  const query = selector => element.querySelector(selector);
  const toolbar = query('[data-dispatch-toolbar]');
  let selectedDate = null;
  const datePicker = datePickerFactory({ element: query('[data-dispatch-date]'), label: '배차일', onChange: date => { if (regions) selectDate(date); } });
  const status = query('[data-dispatch-status]');
  const retry = query('[data-dispatch-retry]');
  const host = query('[data-dispatch-planning]');
  const workflowHost = query('[data-dispatch-workflow]');
  const workflow = workflowFactory({ element: workflowHost, onCommand });
  const previous = query('[data-dispatch-prev]');
  const next = query('[data-dispatch-next]');
  let manifest = null, regions = null, planning = null, simulationData = null, simulationId = null;
  let started = false, available = null, loading = true, current = null, epoch = 0, controller = null, destroyed = false;
  const cache = new Map();
  const listeners = [];
  const listen = (node, type, fn) => { node.addEventListener(type, fn); listeners.push(() => node.removeEventListener(type, fn)); };
  function display() {
    if (simulationData?.sourceData?.date === current?.date) return { ...simulationData, fleetDeliveries: simulationData.dispatchOrders || simulationData.fleetDeliveries, dispatchSource: current, dispatchRegions: regions };
    return { ...adaptDispatchDay(current, regions), dispatch: { phase: 'unplanned', readOnly: true } };
  }
  function updateViews() {
    const operational = simulationData?.sourceData?.date === current?.date ? simulationData : null;
    planning?.update(display(), null);
    workflowHost.hidden = !operational?.dispatch;
    workflow.update(operational, Boolean(operational));
  }
  function message(text, failed = false) {
    status.textContent = text; status.hidden = !text; status.dataset.error = String(failed); retry.hidden = !failed;
  }
  function setNavigation(date) {
    const index = manifest.dates.findIndex(item => item.date === date);
    previous.disabled = !regions || index <= 0; next.disabled = !regions || index < 0 || index >= manifest.dates.length - 1;
    datePicker.update({ value: date, dates: manifest.dates, disabled: !regions });
  }
  async function selectDate(date) {
    const ticket = ++epoch;
    controller?.abort(); controller = new AbortController();
    selectedDate = date; setNavigation(date); current = null; loading = true; host.hidden = true; workflowHost.hidden = true;
    workflow.update(null, false);
    onContextChange();
    if (!manifest.dates.some(item => item.date === date)) { message('선택한 날짜에는 배차가 없습니다.'); loading = false; return; }
    message(`${date} 배차를 불러오고 있습니다.`);
    try {
      const day = cache.get(date) || await fetchJSON(`/api/dispatch-data/days/${date}`, controller.signal);
      if (destroyed || ticket !== epoch) return;
      if (day.date !== date) throw new TypeError('선택 날짜와 응답 날짜가 다릅니다.');
      adaptDispatchDay(day, regions);
      cache.set(date, day);
      if (cache.size > 2) cache.delete(cache.keys().next().value);
      if (onDateChange) {
        const operational = await onDateChange(date);
        if (destroyed || ticket !== epoch) return;
        if (!operational || operational.sourceData?.date !== date) throw new Error('운영 상태를 불러오지 못했습니다.');
        simulationData = operational;
      }
      current = day; loading = false;
      if (!planning) planning = planningFactory({ element: host, ...(onAssign ? { onSelect, onAssign: extra => {
        if (!current || simulationData?.sourceData?.date !== current.date) throw new Error('운영 상태를 먼저 확인해 주세요.');
        return onAssign(extra);
      } } : {}) });
      host.hidden = false;
      updateViews();
      message('');
      const url = new URL(location.href); url.searchParams.set('date', date); history.replaceState(null, '', url);
      try { sessionStorage.setItem('meatbox.dispatch.date', date); } catch { /* Date remains in the URL when storage is unavailable. */ }
      onContextChange();
    } catch (error) {
      if (destroyed || ticket !== epoch || error.name === 'AbortError') return;
      current = null; host.hidden = true; workflowHost.hidden = true;
      loading = false;
      message(error instanceof TypeError ? error.message : '배차 정보를 불러오지 못했습니다. 다시 시도해 주세요.', true);
      onContextChange();
    }
  }
  async function start() {
    started = true; message('배차 정보를 확인하고 있습니다.');
    try {
      manifest = await fetchJSON('/api/dispatch-data/manifest');
      if (destroyed) return;
      let requested = new URLSearchParams(location.search).get('date');
      try { requested ||= sessionStorage.getItem('meatbox.dispatch.date'); } catch { /* Use the configured default. */ }
      const selected = resolveDispatchDate(manifest, requested);
      available = true; toolbar.hidden = false;
      selectedDate = selected; setNavigation(selected);
      message('권역 경계를 불러오고 있습니다.'); onContextChange();
      regions = await fetchJSON('/api/dispatch-data/regions');
      if (destroyed) return;
      await selectDate(selected);
    } catch (error) {
      if (destroyed) return;
      if (error.status === 404 && !manifest) {
        available = false; loading = false;
        message('배차 정보가 준비되지 않아 기존 시나리오를 표시합니다.');
        planning = planningFactory({ element: host, onSelect }); host.hidden = false;
        if (simulationData) planning.update(simulationData, simulationId);
      } else { loading = false; message('배차 자료를 불러오지 못했습니다. 다시 시도해 주세요.', true); }
      onContextChange();
    }
  }
  listen(previous, 'click', () => { const index = manifest.dates.findIndex(item => item.date === selectedDate); if (index > 0) selectDate(manifest.dates[index - 1].date); });
  listen(next, 'click', () => { const index = manifest.dates.findIndex(item => item.date === selectedDate); if (index >= 0 && index < manifest.dates.length - 1) selectDate(manifest.dates[index + 1].date); });
  listen(retry, 'click', () => { if (regions && manifest) selectDate(selectedDate); else start(); });
  return {
    update(data, selectedId) {
      simulationData = data; simulationId = selectedId;
      if (!started) start();
      else if (available === false) planning?.update(data, selectedId);
      else if (current && data?.sourceData && !loading) {
        if (current.date !== data.sourceData.date) selectDate(data.sourceData.date);
        else updateViews();
      }
    },
    usesSource: () => available !== false,
    summary: () => loading ? null : current?.summary || null,
    destroy() { destroyed = true; epoch++; controller?.abort(); planning?.destroy(); workflow.destroy(); datePicker.destroy(); listeners.forEach(remove => remove()); },
  };
}
