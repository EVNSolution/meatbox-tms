import { clock, groupPeriods, parseDashboard, periodLabel, rulesText, zoneTotals, type Dashboard, type DayRow, type Grain } from './dashboard-model.ts';

// 운영 현황: the dashboard of finished and running days. One request per range (the server allows 31 days); day, week and
// month are sums of the same days. Reads only.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const MAX_DAYS = 31;
const GRAINS: [Grain, string][] = [['day', '일별'], ['week', '주별'], ['month', '월별']];
const number = (value: number | null, digits = 1): string => (value === null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: digits }));
const won = (value: number): string => `${value.toLocaleString('ko-KR')}원`;

const messages: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  403: '운영자 계정만 운영 현황을 볼 수 있습니다.',
  404: '이 환경에는 운영 현황 기능이 없습니다.',
  503: '운영 현황을 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
};

const shift = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function checkRange(from: string, to: string): string {
  const valid = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && shift(value, 0) === value;
  if (!valid(from) || !valid(to)) return '시작일과 종료일을 날짜로 입력해 주세요.';
  if (to < from) return '종료일은 시작일 뒤여야 합니다.';
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > MAX_DAYS) return `한 번에 ${MAX_DAYS}일까지 볼 수 있습니다.`;
  return '';
}

export function dashboardMarkup(): string {
  return `<section class="ops-dashboard" aria-labelledby="ops-dashboard-heading" data-ops-dashboard>
    <h2 id="ops-dashboard-heading" class="sr-only">운영 현황</h2>
    <form class="ops-dashboard-range" data-dash-form><label class="field"><span>시작일</span><input type="date" name="from" data-dash-from></label>
      <label class="field"><span>종료일</span><input type="date" name="to" data-dash-to></label>
      <button type="submit" class="button primary" data-dash-load>조회</button>
      <div class="ops-dashboard-presets" role="group" aria-label="기간 바로 선택"><button type="button" class="button subtle" data-dash-preset="7">최근 7일</button><button type="button" class="button subtle" data-dash-preset="14">최근 14일</button><button type="button" class="button subtle" data-dash-preset="31">최근 31일</button></div>
      <div class="ops-dashboard-grain" role="group" aria-label="집계 단위">${GRAINS.map(([value, label]) => `<label><input type="radio" name="grain" value="${value}" data-dash-grain ${value === 'day' ? 'checked' : ''}> ${label}</label>`).join('')}</div></form>
    <p class="resource-message" role="status" data-dash-message></p><div data-dash-body></div></section>`;
}

export function periodTable(dashboard: Dashboard, grain: Grain): string {
  const periods = groupPeriods(dashboard.days, grain);
  if (!periods.length) return '<p class="muted">이 기간에 주문이 있는 날이 없습니다.</p>';
  const fee = dashboard.rules !== null;
  return `<div class="resource-table-scroll"><table class="resource-table ops-table" data-dash-periods><thead><tr><th scope="col">기간</th><th scope="col">주문</th><th scope="col">박스</th><th scope="col">착지</th><th scope="col">착지당 박스</th><th scope="col">운행 차량</th><th scope="col">완료 박스</th>${fee ? '<th scope="col">추가 수수료 인원</th><th scope="col">추가 수수료</th>' : ''}</tr></thead><tbody>${periods.map(period => `<tr><th scope="row">${esc(periodLabel(period.key, grain))}</th><td>${number(period.orders, 0)}</td><td>${number(period.boxes)}</td><td>${number(period.stops, 0)}</td><td>${number(period.boxesPerStop)}</td><td>${number(period.vehicles, 0)}</td><td>${number(period.boxesDelivered)}</td>${fee ? `<td>${period.incentive ? `${number(period.incentive.people, 0)}명` : '—'}</td><td>${period.incentive ? won(period.incentive.amount) : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

export function vehicleTable(dashboard: Dashboard): string {
  const rows = dashboard.days.flatMap(day => day.vehicles.map(vehicle => ({ day, vehicle })));
  if (!rows.length) return '<p class="muted">이 기간에 확정된 배차가 없습니다.</p>';
  const fee = dashboard.rules !== null;
  return `<div class="resource-table-scroll"><table class="resource-table ops-table" data-dash-vehicles><thead><tr><th scope="col">날짜</th><th scope="col">기사·차량</th><th scope="col">출발</th><th scope="col">마지막 도착</th><th scope="col">완료</th><th scope="col">운행 시간(분)</th><th scope="col">추정 거리(km)</th><th scope="col">착지 완료/전체</th><th scope="col">박스 완료/전체</th><th scope="col">착지당 박스</th><th scope="col">착지당 분</th>${fee ? '<th scope="col">목표 초과 수수료</th>' : ''}</tr></thead><tbody>${rows.map(({ day, vehicle }) => `<tr><th scope="row">${esc(day.date)}</th><td>${esc(vehicle.label || vehicle.plate || vehicle.vehicleId)}${vehicle.plate && vehicle.label ? ` <small class="muted">${esc(vehicle.plate)}</small>` : ''}</td><td>${clock(vehicle.departedAt)}</td><td>${clock(vehicle.lastArrivedAt)}</td><td>${vehicle.finishedAt ? clock(vehicle.finishedAt) : '<span class="muted">진행 중</span>'}</td><td>${number(vehicle.driveMinutes)}</td><td>${number(vehicle.distanceKm)}</td><td>${number(vehicle.stopsDone, 0)} / ${number(vehicle.stops, 0)}</td><td>${number(vehicle.boxesDelivered)} / ${number(vehicle.boxes)}</td><td>${number(vehicle.boxesPerStop)}</td><td>${number(vehicle.minutesPerStop)}</td>${fee ? `<td>${vehicle.incentive ? (vehicle.incentive.excess > 0 ? won(vehicle.incentive.amount) : '—') : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

export function zoneTable(days: DayRow[], labels: Map<string, string>): string {
  const zones = zoneTotals(days);
  const unlocated = days.reduce((sum, day) => sum + day.unlocatedOrders, 0);
  const note = unlocated ? `<p class="muted">권역을 알 수 없는 주문 ${unlocated.toLocaleString('ko-KR')}건은 권역별 표에 들어가지 않습니다(CSV 날짜의 권역만 집계하고, 미트박스 주문은 좌표로 권역을 정하는 배차 화면과 달리 여기서는 계산하지 않습니다).</p>` : '';
  if (!zones.length) return `<p class="muted">이 기간에 권역이 정해진 주문이 없습니다.</p>${note}`;
  return `<div class="resource-table-scroll"><table class="resource-table ops-table" data-dash-zones><thead><tr><th scope="col">권역</th><th scope="col">주문</th><th scope="col">박스</th><th scope="col">착지(일별 합)</th></tr></thead><tbody>${zones.map(zone => `<tr><th scope="row">${esc(labels.get(zone.zoneId) ?? zone.zoneId)}</th><td>${number(zone.orders, 0)}</td><td>${number(zone.boxes)}</td><td>${number(zone.stops, 0)}</td></tr>`).join('')}</tbody></table></div>${note}`;
}

type Node = { innerHTML: string; textContent: string; value?: string; checked?: boolean; disabled?: boolean; dataset?: Record<string, string>; addEventListener(type: string, listener: (event: any) => void): void; querySelector?(selector: string): Node | null };

export function mountDashboard({ element, fetchImpl = fetch, today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }) }: {
  element: { querySelector(selector: string): Node | null }; fetchImpl?: typeof fetch; today?: () => string;
}) {
  const root = element.querySelector('[data-ops-dashboard]')!;
  const from = element.querySelector('[data-dash-from]')!;
  const to = element.querySelector('[data-dash-to]')!;
  const body = element.querySelector('[data-dash-body]')!;
  const message = element.querySelector('[data-dash-message]')!;
  let grain: Grain = 'day';
  let dashboard: Dashboard | null = null;
  let labels = new Map<string, string>();
  let epoch = 0;
  let controller: AbortController | undefined;
  let started = false;

  function render(): void {
    if (!dashboard) { body.innerHTML = ''; return; }
    const summary = dashboard.days.filter(day => !day.error);
    const failed = dashboard.days.filter(day => day.error);
    message.textContent = failed.length ? `${failed.map(day => day.date).join(', ')}은(는) 자료 충돌로 집계하지 못했습니다.` : '';
    body.innerHTML = `<p class="ops-dashboard-note muted">${esc(rulesText(dashboard))}</p>
      <h3>배송량 (${esc(GRAINS.find(([value]) => value === grain)![1])})</h3>${periodTable(dashboard, grain)}
      <h3>차량별 운행</h3><p class="muted">운행 거리는 직선거리에 우회 계수를 곱한 추정값입니다. 실제 주행 거리는 수신하지 않아 미수신입니다. 기사는 지금 기준의 배정입니다. 날짜별로 따로 기록하지 않습니다.</p>${vehicleTable(dashboard)}
      <h3>권역별 현황</h3>${zoneTable(summary, labels)}`;
  }

  async function load(): Promise<void> {
    const problem = checkRange(from.value ?? '', to.value ?? '');
    if (problem) { message.textContent = problem; return; }
    controller?.abort();
    controller = new AbortController();
    const mine = ++epoch;
    message.textContent = '불러오고 있습니다.';
    try {
      const response = await fetchImpl(`/api/ops/dashboard?from=${encodeURIComponent(from.value!)}&to=${encodeURIComponent(to.value!)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(messages[response.status] ?? '운영 현황을 불러오지 못했습니다.');
      const next = parseDashboard(await response.json());
      if (mine !== epoch) return;
      dashboard = next;
      message.textContent = '';
      void loadLabels();
    } catch (cause) {
      if (mine !== epoch) return;
      dashboard = null;
      message.textContent = cause instanceof Error ? cause.message : '운영 현황을 불러오지 못했습니다.';
    }
    render();
  }

  async function loadLabels(): Promise<void> {
    try {
      const response = await fetchImpl('/api/dispatch-data/regions', { credentials: 'same-origin' });
      const regions = await response.json();
      labels = new Map((regions?.features ?? []).map((feature: { properties?: { zoneId?: string; label?: string } }) => [feature.properties?.zoneId ?? '', feature.properties?.label ?? feature.properties?.zoneId ?? '']));
      render();
    } catch { /* the zone ids stand in for the labels */ }
  }

  function preset(days: number): void {
    to.value = today();
    from.value = shift(to.value, -(days - 1));
    void load();
  }

  root.addEventListener('submit', (event: { preventDefault(): void }) => { event.preventDefault(); void load(); });
  root.addEventListener('click', (event: { target: { closest(selector: string): { dataset: Record<string, string> } | null } }) => {
    const button = event.target.closest('[data-dash-preset]');
    if (button) preset(Number(button.dataset.dashPreset));
  });
  root.addEventListener('change', (event: { target: { dataset?: Record<string, string>; value: string } }) => {
    if (event.target.dataset?.dashGrain === undefined) return;
    grain = event.target.value as Grain;
    render();
  });

  return {
    /** Called when the page is shown: the first time it loads the last 7 days. */
    show(): void { if (!started) { started = true; preset(7); } },
    destroy(): void { epoch += 1; controller?.abort(); },
  };
}
