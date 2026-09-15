export function sourceDate(manifest, requested) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.dates) || !manifest.dates.some(item => item.date === manifest.defaultDate)) throw new Error('날짜 목록을 확인할 수 없습니다.');
  return manifest.dates.some(item => item.date === requested) ? requested : manifest.defaultDate;
}

export function connectSourceOperations({ manifest, onState, onStatus, onError, login }) {
  let state = null, etag = null, timer = null, stopped = false, epoch = 0, pending = false;
  let requested = new URLSearchParams(location.search).get('date');
  try { requested ||= sessionStorage.getItem('meatbox.dispatch.date'); } catch {}
  let date = sourceDate(manifest, requested);
  const endpoint = suffix => `/api/dispatch-data/days/${date}/${suffix}`;
  const dates = manifest.dates.map(item => ({ date: item.date, weekday: item.weekday }));
  function receive(next) {
    if (next?.sourceData?.date !== date || !Number.isInteger(next.revision) || !Array.isArray(next.fleetDeliveries)) throw new Error('선택한 날짜와 배송 자료가 일치하지 않습니다.');
    if (state?.boot && next.boot && state.boot !== next.boot) { location.reload(); return; }
    if (state && next.revision < state.revision) return;
    state = { ...next, sourceData: { ...next.sourceData, dates } };
    const url = new URL(location.href); url.searchParams.set('date', date); history.replaceState(null, '', url);
    try { sessionStorage.setItem('meatbox.dispatch.date', date); } catch {}
    onState(state, { boot: state.boot }); onStatus(true, '');
  }
  function schedule() { clearTimeout(timer); if (!stopped) timer = setTimeout(refresh, 2000); }
  async function refresh() {
    if (stopped) return null;
    const ticket = epoch;
    try {
      const response = await fetch(endpoint('state'), { headers: etag ? { 'If-None-Match': etag } : {} });
      if (stopped || ticket !== epoch) return null;
      if (response.status === 401) { stopped = true; login(); return null; }
      if (response.status === 304) { onStatus(true, ''); return state; }
      if (!response.ok) throw new Error('배송 상태를 불러오지 못했습니다.');
      const next = await response.json();
      if (stopped || ticket !== epoch) return null;
      receive(next); etag = response.headers.get('etag'); return state;
    } catch (error) {
      if (!stopped && ticket === epoch) onStatus(false, error.message || '배송 정보를 다시 연결하고 있습니다.');
      return null;
    } finally { if (ticket === epoch) schedule(); }
  }
  async function selectDate(nextDate) {
    if (!dates.some(item => item.date === nextDate)) throw new Error('선택한 날짜에는 배차가 없습니다.');
    if (date === nextDate && state) return state;
    epoch++; clearTimeout(timer); date = nextDate; state = null; etag = null;
    onStatus(false, `${date} 주문을 불러오고 있습니다.`);
    return refresh();
  }
  const dateChange = event => { selectDate(event.detail).catch(error => onError(error.message)); };
  window.addEventListener('meatbox:source-date', dateChange);
  refresh();
  return {
    selectDate,
    async send(type, extra = {}) {
      if (!state || pending) { onError('연결과 이전 요청 처리를 확인한 뒤 다시 진행해 주세요.'); return null; }
      if (state.dispatch?.readOnly) { onError('과거 배차 기록은 변경할 수 없습니다.'); return null; }
      pending = true;
      const ticket = epoch;
      const selectedId = extra.stopId || new URLSearchParams(location.search).get('id') || state.customerStopId;
      const vehicleId = extra.vehicleId || state.fleetDeliveries.find(stop => stop.id === selectedId)?.vehicleId || state.sourceData.defaultVehicleId;
      try {
        const response = await fetch(endpoint('commands'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, ...extra, vehicleId, expectedRevision: state.revision, expectedBoot: state.boot }) });
        if (response.status === 401) { login(); return null; }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || payload.error || '요청을 처리하지 못했습니다.');
        if (stopped || ticket !== epoch) return null;
        receive(payload.state); etag = null; return payload.result ?? {};
      } catch (error) {
        if (!stopped && ticket === epoch) { await refresh(); onError(error.message); }
        return null;
      } finally { pending = false; }
    },
    close() { stopped = true; epoch++; clearTimeout(timer); window.removeEventListener('meatbox:source-date', dateChange); },
  };
}
