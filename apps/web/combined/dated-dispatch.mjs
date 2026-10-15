import { mountDatePicker } from './date-picker.mjs';
import { mountOrderPlanning } from './order-planning.mjs';
import { createDispatchFleet } from './dispatch-assignment.mjs';
import { mountDispatchWorkflow } from './dispatch-workflow.mjs';
import { seoulToday, validOperatingDate } from './operating-date.mjs';
import { dateNavActions, dateSummaryToolbar, mountDateSummaryToolbar } from './date-summary-toolbar.mjs';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

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

export function resolveDispatchDate(manifest, requested, today = seoulToday) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.dates) || !manifest.dates.length) throw new TypeError('날짜 목록이 비어 있습니다.');
  const dates = manifest.dates.map(item => item.date);
  if (dates.some(date => !datePattern.test(date)) || new Set(dates).size !== dates.length || !dates.includes(manifest.defaultDate)) throw new TypeError('날짜 목록이 올바르지 않습니다.');
  return requested == null ? today() : validOperatingDate(requested) ? requested : null;
}

export function mountDatedDispatch({ element, onSelect, onAssign, onCommand, onDateChange, onContextChange = () => {}, now = seoulToday, fetchJSON = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) { const error = new Error('자료를 불러오지 못했습니다.'); error.status = response.status; throw error; }
  return response.json();
}, planningFactory = mountOrderPlanning, datePickerFactory = mountDatePicker, workflowFactory = mountDispatchWorkflow, notify = () => {} }) {
  element.innerHTML = `${dateSummaryToolbar({ label: '배차 날짜', actionsClass: 'date-nav', attributes: 'data-dispatch-toolbar hidden', summaryLabel: '선택 배차일 요약', actions: dateNavActions('배차일', 'data-dispatch-date'), context: '<span class="dispatch-readonly" data-dispatch-readonly hidden>이력 조회 (읽기 전용)</span>' })}<div data-dispatch-workflow hidden></div><div data-dispatch-planning hidden></div>`;
  const query = selector => element.querySelector(selector);
  const toolbar = query('[data-dispatch-toolbar]');
  const toolbarSummary = mountDateSummaryToolbar(toolbar);
  let selectedDate = null, externalDate;
  const datePicker = datePickerFactory({ element: query('[data-dispatch-date]'), label: '배차일', onChange: date => { if (regions) selectDate(date); } });
  const host = query('[data-dispatch-planning]');
  const workflowHost = query('[data-dispatch-workflow]');
  const readOnly = query('[data-dispatch-readonly]');
  const workflow = workflowFactory({ element: workflowHost, onCommand });
  const previous = query('[data-date-prev]');
  const next = query('[data-date-next]');
  const todayButton = query('[data-date-today]');
  let manifest = null, regions = null, planning = null, operationalData = null;
  let started = false, available = null, loading = true, current = null, epoch = 0, controller = null, destroyed = false, confirmedEmpty = false;
  const cache = new Map();
  const listeners = [];
  const listen = (node, type, fn) => { node.addEventListener(type, fn); listeners.push(() => node.removeEventListener(type, fn)); };
  function showUnavailable(text, empty = false) {
    confirmedEmpty = empty;
    if (!planning) planning = planningFactory({ element: host, ...(onAssign ? { onSelect, onAssign: extra => {
      if (!current || operationalData?.sourceData?.date !== current.date) throw new Error('운영 상태를 먼저 확인해 주세요.');
      return onAssign(extra);
    } } : {}) });
    host.hidden = false; workflowHost.hidden = false;
    planning.clear({ empty, message: text });
    workflow.update(null, false, { date: selectedDate, empty });
    if (empty) toolbarSummary.update([['주문', 0], ['박스', 0]]);
    else toolbarSummary.clear();
  }
  function display() {
    if (operationalData?.sourceData?.date === current?.date) return { ...operationalData, fleetDeliveries: operationalData.dispatchOrders || operationalData.fleetDeliveries, dispatchSource: current, dispatchRegions: regions };
    return { ...adaptDispatchDay(current, regions), dispatch: { phase: 'unplanned', readOnly: true } };
  }
  function updateViews() {
    const operational = operationalData?.sourceData?.date === current?.date ? operationalData : null;
    if (!current.orders.length) planning?.clear({ empty: true, message: `${current.date}에 등록된 주문이 없습니다.` });
    else planning?.update(display(), null);
    workflowHost.hidden = !operational?.dispatch;
    workflow.update(operational, Boolean(operational));
  }
  function retryLoad() { if (regions && manifest) selectDate(selectedDate); else start(); }
  function message(text, failed = false) {
    notify({ message: text, failed, retry: failed ? retryLoad : null });
  }
  function renderSummary() {
    if (loading || !current) { toolbarSummary.clear(); return; }
    const { orders, boxes } = current.summary;
    toolbarSummary.update([['주문', orders], ['박스', boxes]]);
  }
  function setNavigation(date) {
    const today = now();
    const index = manifest.dates.findIndex(item => item.date === date);
    previous.disabled = !regions || index <= 0; next.disabled = !regions || index < 0 || index >= manifest.dates.length - 1;
    todayButton.disabled = !regions || date === today;
    datePicker.update({ value: date, dates: [...manifest.dates, { date: today }], disabled: !regions });
    readOnly.hidden = !(validOperatingDate(date) && date < today);
  }
  async function selectDate(date) {
    const ticket = ++epoch;
    controller?.abort(); controller = new AbortController();
    selectedDate = date; setNavigation(date); current = null; loading = true;
    showUnavailable('주문 자료를 불러오고 있습니다.');
    onContextChange();
    if (!date || !manifest.dates.some(item => item.date === date)) {
      const text = date ? `${date}에 등록된 주문이 없습니다. 주문이 등록되면 이 화면에 표시됩니다.` : '요청한 날짜가 올바르지 않습니다. 배차 날짜를 다시 선택해 주세요.';
      if (date && onDateChange) {
        try { await onDateChange(date); } catch {
          if (destroyed || ticket !== epoch) return;
          loading = false; showUnavailable('운영 상태를 확인하지 못했습니다.');
          message('운영 상태를 불러오지 못했습니다. 다시 시도해 주세요.', true); onContextChange(); return;
        }
      }
      if (destroyed || ticket !== epoch) return;
      showUnavailable(text, Boolean(date)); message(date ? '' : text);
      loading = false; onContextChange(); return;
    }
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
        if (!operational) { loading = false; showUnavailable('운영 상태를 확인하지 못했습니다.'); message(`${date}의 운영 상태를 불러오지 못했습니다. 다시 시도해 주세요.`, true); onContextChange(); return; }
        if (operational.sourceData?.date !== date) throw new Error('운영 상태를 불러오지 못했습니다.');
        operationalData = operational;
      }
      current = day; loading = false;
      confirmedEmpty = day.orders.length === 0;
      host.hidden = false;
      updateViews();
      renderSummary();
      message('');
      const url = new URL(location.href); url.searchParams.set('date', date); history.replaceState(null, '', url);
      onContextChange();
    } catch (error) {
      if (destroyed || ticket !== epoch || error.name === 'AbortError') return;
      current = null; showUnavailable('주문 자료를 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.');
      loading = false;
      message(error instanceof TypeError ? error.message : '배차 정보를 불러오지 못했습니다. 다시 시도해 주세요.', true);
      onContextChange();
    }
  }
  async function start() {
    started = true; showUnavailable('주문 자료를 확인하고 있습니다.'); message('배차 정보를 확인하고 있습니다.');
    try {
      manifest = await fetchJSON('/api/dispatch-data/manifest');
      if (destroyed) return;
      const requested = new URLSearchParams(location.search).get('date');
      const selected = resolveDispatchDate(manifest, requested, now);
      available = true; toolbar.hidden = false;
      selectedDate = selected; setNavigation(selected);
      message('권역 경계를 불러오고 있습니다.'); onContextChange();
      regions = await fetchJSON('/api/dispatch-data/regions');
      if (destroyed) return;
      await selectDate(externalDate === undefined ? selected : externalDate);
    } catch {
      if (destroyed) return;
      loading = false; showUnavailable('주문 자료를 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.'); message('배차 자료를 불러오지 못했습니다. 다시 시도해 주세요.', true);
      onContextChange();
    }
  }
  listen(previous, 'click', () => { const index = manifest.dates.findIndex(item => item.date === selectedDate); if (index > 0) selectDate(manifest.dates[index - 1].date); });
  listen(next, 'click', () => { const index = manifest.dates.findIndex(item => item.date === selectedDate); if (index >= 0 && index < manifest.dates.length - 1) selectDate(manifest.dates[index + 1].date); });
  listen(todayButton, 'click', () => selectDate(now()));
  return {
    update(data, _selectedId, contextDate) {
      operationalData = data;
      const contextChanged = contextDate !== undefined && contextDate !== externalDate;
      if (contextDate !== undefined) externalDate = contextDate;
      if (!started) start();
      else if (regions && contextChanged && selectedDate !== contextDate) selectDate(contextDate);
      else if (regions && !loading && !current && data?.sourceData?.date === selectedDate) selectDate(selectedDate);
      else if (current && data?.sourceData && !loading) {
        if (current.date !== data.sourceData.date) selectDate(data.sourceData.date);
        else updateViews();
      }
    },
    usesSource: () => available !== false,
    status: () => ({ date: selectedDate, empty: confirmedEmpty && !loading }),
    summary: () => loading ? null : current?.summary || null,
    destroy() { destroyed = true; epoch++; controller?.abort(); notify({ message: '', failed: false, retry: null }); planning?.destroy(); workflow.destroy(); datePicker.destroy(); listeners.forEach(remove => remove()); },
  };
}
