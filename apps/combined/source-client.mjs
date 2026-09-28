import { seoulToday, validOperatingDate } from './operating-date.mjs';

export function sourceDate(manifest, requested, today = seoulToday) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.dates) || !manifest.dates.some(item => item.date === manifest.defaultDate)) throw new Error('날짜 목록을 확인할 수 없습니다.');
  return requested == null ? today() : validOperatingDate(requested) ? requested : null;
}

export function connectSourceOperations({ manifest, onState, onStatus, onError, onDateContext = () => {}, login, now = seoulToday }) {
  let state = null, etag = null, timer = null, stopped = false, epoch = 0, pending = null;
  const requests = new Set();
  const requested = new URLSearchParams(location.search).get('date');
  let date = sourceDate(manifest, requested, now);
  const endpoint = suffix => `/api/dispatch-data/days/${date}/${suffix}`;
  const dates = manifest.dates.map(item => ({ date: item.date, weekday: item.weekday }));
  const context = (empty = false) => onDateContext({ date: date ?? requested, dates, empty, invalid: date === null });
  function syncUrl() {
    if (!date) return;
    const url = new URL(location.href); url.searchParams.set('date', date); history.replaceState(null, '', url);
  }
  function cancelRequests() { for (const controller of requests) controller.abort(); }
  function close() { stopped = true; epoch++; clearTimeout(timer); cancelRequests(); window.removeEventListener('meatbox:source-date', dateChange); }
  async function request(suffix, options = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const deadline = setTimeout(() => controller.abort(new Error(options.method === 'POST'
      ? '서버 응답이 늦어 처리 여부를 확인할 수 없습니다. 최신 상태를 확인해 주세요.'
      : '배송 상태 응답이 늦어 다시 연결하고 있습니다.')), 10000);
    try {
      const response = await fetch(endpoint(suffix), { ...options, signal: controller.signal });
      const payload = [304, 401].includes(response.status) ? null : await response.json();
      return { response, payload };
    } finally { clearTimeout(deadline); requests.delete(controller); }
  }
  function receive(next) {
    if (next?.sourceData?.date !== date || !Number.isInteger(next.revision) || !Array.isArray(next.fleetDeliveries)) throw new Error('선택한 날짜와 배송 자료가 일치하지 않습니다.');
    if (state?.boot && next.boot && state.boot !== next.boot) { close(); onStatus(false, '서버가 다시 시작되어 최신 상태를 불러옵니다.'); location.reload(); return false; }
    if (state && next.revision < state.revision) return false;
    const received = { ...next, sourceData: { ...next.sourceData, dates } };
    onState(received, { boot: received.boot });
    state = received;
    syncUrl();
    onStatus(true, '');
    return true;
  }
  function schedule() { clearTimeout(timer); if (!stopped) timer = setTimeout(refresh, 2000); }
  async function refresh() {
    if (stopped) return null;
    if (date === null || !dates.some(item => item.date === date)) {
      syncUrl(); context(true); onStatus(true, '선택한 날짜에 자료가 없습니다.'); return null;
    }
    const ticket = epoch;
    let absent = false;
    try {
      const { response, payload } = await request('state', { headers: etag ? { 'If-None-Match': etag } : {} });
      if (stopped || ticket !== epoch) return null;
      if (response.status === 401) { close(); login(); return null; }
      if (response.status === 404) { absent = true; state = null; etag = null; syncUrl(); context(true); onStatus(true, '선택한 날짜에 자료가 없습니다.'); return null; }
      if (response.status === 304) {
        if (!state) throw new Error('배송 상태를 다시 불러오고 있습니다.');
        onStatus(true, ''); return state;
      }
      if (!response.ok) throw new Error('배송 상태를 불러오지 못했습니다.');
      if (receive(payload)) etag = response.headers.get('etag');
      return stopped ? null : state;
    } catch (error) {
      if (!stopped && ticket === epoch) onStatus(false, error.message || '배송 정보를 다시 연결하고 있습니다.');
      return null;
    } finally { if (ticket === epoch && !absent) schedule(); }
  }
  async function selectDate(nextDate) {
    if (stopped) return null;
    if (!validOperatingDate(nextDate)) throw new Error('조회 날짜가 올바르지 않습니다.');
    if (date === nextDate && state) return state;
    epoch++; clearTimeout(timer); cancelRequests(); date = nextDate; state = null; etag = null;
    syncUrl();
    context(false); onStatus(false, `${date} 주문을 불러오고 있습니다.`);
    return refresh();
  }
  const dateChange = event => { selectDate(event.detail).catch(error => onError(error.message)); };
  window.addEventListener('meatbox:source-date', dateChange);
  context(false); refresh();
  return {
    selectDate,
    async send(type, extra = {}) {
      if (stopped) return null;
      if (!state || pending?.epoch === epoch) { onError('연결과 이전 요청 처리를 확인한 뒤 다시 진행해 주세요.'); return null; }
      if (state.dispatch?.readOnly) { onError('과거 배차 기록은 변경할 수 없습니다.'); return null; }
      const ticket = epoch;
      const command = { epoch: ticket }; pending = command;
      const selectedId = extra.stopId || new URLSearchParams(location.search).get('id') || state.customerStopId;
      const vehicleId = extra.vehicleId || state.fleetDeliveries.find(stop => stop.id === selectedId)?.vehicleId || state.sourceData.defaultVehicleId;
      try {
        const { response, payload } = await request('commands', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, ...extra, vehicleId, expectedRevision: state.revision, expectedBoot: state.boot }) });
        if (stopped || ticket !== epoch) return null;
        if (response.status === 401) { close(); login(); return null; }
        if (!response.ok) throw new Error(payload.message || payload.error || '요청을 처리하지 못했습니다.');
        receive(payload.state); etag = null; return stopped ? null : payload.result ?? {};
      } catch (error) {
        if (!stopped && ticket === epoch) {
          await refresh();
          if (!stopped && ticket === epoch) onError(error.message);
        }
        return null;
      } finally { if (pending === command) pending = null; }
    },
    close,
  };
}
