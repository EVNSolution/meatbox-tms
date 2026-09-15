import { publishedEtaText } from './simulation-adapter.mjs';
import { scenarioGuide } from './scenario-guide.mjs';

const stopName = stop => `${stop.sequence}번 ${stop.name}`;

export function deliveryLinks(id, date) {
  const params = new URLSearchParams();
  if (/^(?:S[1-8]|V(?:[2-9]|[1-9][0-9]|1[0-2][0-9]|130)-S[1-3]|ord_[a-f0-9]{8,64})$/.test(id || '')) params.set('id', id);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) params.set('date', date);
  const query = params.size ? `?${params}` : '';
  return {
    mobile: `/combined/mobile-customer.html${query}`,
    customer: `/combined/mobile-customer.html${query}`,
    driver: `/combined/driver.html${query}`,
    operator: `/combined/${query}#/control`,
  };
}

export function deliveryContext(state, selected) {
  const current = state.deliveries.find(stop => stop.status === 'current');
  const first = state.deliveries.find(stop => stop.status === 'pending');
  const ordering = state.deliveries.find(stop => stop.id === state.customerStopId);
  const vehicle = current ? `${stopName(current)} ${state.truck?.dwelling ? '하차 중' : '이동 중'}`
    : first ? `출발 전 · 첫 목적지 ${stopName(first)}` : '배송 종료';
  let note;
  if (!selected) note = '조회 조건에 맞는 배송을 선택하면 고객 화면과 비교할 수 있습니다.';
  else if (selected.status === 'done') note = `보고 있는 배송은 ${selected.completedAt || '시각 미확인'}에 완료되었습니다. 차량은 남은 배송을 이어갑니다.`;
  else if (selected.status === 'skipped') note = '보고 있는 배송은 보류 상태이며, 남은 배송 순서에서 제외됩니다.';
  else if (state.phase === 'unordered') note = `주문은 ${ordering ? stopName(ordering) : '선택 고객'}에서 시작합니다. 차량은 ${first ? stopName(first) : '첫 목적지'}부터 배송합니다.`;
  else if (current?.id === selected.id) note = state.truck?.dwelling ? '차량이 이 매장에 도착했습니다. 하차 후 배송 완료를 기록합니다.' : '차량이 지금 보고 있는 매장으로 이동 중입니다.';
  else if (current) {
    const before = state.deliveries.slice(0, state.deliveries.indexOf(selected)).filter(stop => ['pending', 'current'].includes(stop.status)).length;
    note = `앞선 배송 ${before}곳이 남아 있습니다. 배송 완료는 매장별로 표시합니다.`;
  } else note = '출고 준비 중입니다. 출발하면 현재 목적지가 표시됩니다.';
  if (state.phase === 'done' && selected?.status === 'done') note = `보고 있는 배송은 ${selected.completedAt || '시각 미확인'}에 완료되었고, 전체 배송도 종료되었습니다.`;
  return { vehicle, customer: selected ? `${stopName(selected)} · ${selected.customerStatus.label}` : '선택 없음', note };
}

// Keep only meaningful displayed changes; clock ticks and live calculation noise are not events.
export function deliveryChanges(previous, next) {
  if (!previous || (next.phase === 'unordered' && previous.phase !== 'unordered')) return null;
  const compare = (rows, label, before, after) => {
    if (before !== after) rows.push({ label, before: before || '미기록', after: after || '미기록' });
  };
  const global = [];
  compare(global, '배송 단계', scenarioGuide(previous).title, scenarioGuide(next).title);
  compare(global, '완료 배송', `${previous.deliveries.filter(stop => stop.status === 'done').length}곳`, `${next.deliveries.filter(stop => stop.status === 'done').length}곳`);
  if (next.incidents.length > previous.incidents.length) compare(global, '추가 상황', previous.incidents.at(-1)?.label || '없음', next.incidents.at(-1)?.label);
  const deliveries = {};
  for (const stop of next.deliveries) {
    const before = previous.deliveries.find(item => item.id === stop.id);
    if (!before) continue;
    const rows = [];
    compare(rows, '고객 배송 상태', before.customerStatus.label, stop.customerStatus.label);
    compare(rows, '배송 순서', `${before.sequence}번째`, `${stop.sequence}번째`);
    if (!['done', 'skipped'].includes(stop.status)) compare(rows, '고객 공식 ETA', publishedEtaText(before), publishedEtaText(stop));
    compare(rows, '도착 시각', before.arrivedAt, stop.arrivedAt);
    compare(rows, '완료 시각', before.completedAt, stop.completedAt);
    if (stop.notices.length > before.notices.length) compare(rows, '고객 알림 문구', before.notices.at(-1)?.title || '없음', stop.notices.at(-1)?.title);
    if (rows.length) deliveries[stop.id] = { name: stopName(stop), rows };
  }
  return global.length || Object.keys(deliveries).length ? { time: next.simClock, global, deliveries } : null;
}
