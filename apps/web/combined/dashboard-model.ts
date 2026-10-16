// The numbers of the 운영 현황 page, from `GET /api/ops/dashboard`. Pure: it groups days into weeks and months and sums.
// A figure the server could not know stays null; a sum over days with an unknown figure is unknown, never a smaller number.

export type Incentive = { people: number; amount: number };
export type VehicleDay = {
  vehicleId: string; plate: string; label: string; driver: string | null;
  stops: number; boxes: number; orders: number; stopsDone: number; boxesDelivered: number; ordersDone: number; stopsSkipped: number;
  departedAt: string | null; lastArrivedAt: string | null; finishedAt: string | null; driveMinutes: number | null;
  distanceKm: number | null; boxesPerStop: number; minutesPerStop: number | null;
  incentive: { target: number; delivered: number; excess: number; amount: number } | null;
};
export type DayRow = {
  date: string; phase: string; orders: number; boxes: number; stops: number; vehicles: VehicleDay[];
  zones: { zoneId: string; orders: number; boxes: number; stops: number }[]; unlocatedOrders: number; error: string; incentive: Incentive | null;
};
export type Rules = { unit: 'boxes' | 'stops' | 'orders'; dailyTarget: number; ratePerUnit: number; targetsByDriver: Record<string, number> };
export type Dashboard = { from: string; to: string; days: DayRow[]; rules: Rules | null; rulesError: boolean };
export type Grain = 'day' | 'week' | 'month';
export type Period = {
  key: string; days: number; orders: number; boxes: number; stops: number; boxesPerStop: number | null;
  vehicles: number; boxesDelivered: number; incentive: Incentive | null;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(record) : []);

export function parseDashboard(payload: unknown): Dashboard {
  if (!record(payload) || !Array.isArray(payload.days)) throw new TypeError('운영 현황 응답을 확인할 수 없습니다.');
  const rules = record(payload.incentiveRules) ? payload.incentiveRules : null;
  return {
    from: str(payload.from), to: str(payload.to), rulesError: typeof payload.incentiveRulesError === 'string',
    rules: rules && ['boxes', 'stops', 'orders'].includes(str(rules.unit)) ? {
      unit: str(rules.unit) as Rules['unit'], dailyTarget: num(rules.dailyTarget), ratePerUnit: num(rules.ratePerUnit),
      targetsByDriver: record(rules.targetsByDriver) ? Object.fromEntries(Object.entries(rules.targetsByDriver).map(([name, value]) => [name, num(value)])) : {},
    } : null,
    days: list(payload.days).map((day): DayRow => ({
      date: str(day.date), phase: str(day.phase), orders: num(day.orders), boxes: num(day.boxes), stops: num(day.stops), error: str(day.error),
      unlocatedOrders: num(day.unlocatedOrders),
      incentive: record(day.incentive) ? { people: num(day.incentive.people), amount: num(day.incentive.amount) } : null,
      zones: list(day.zones).map(zone => ({ zoneId: str(zone.zoneId), orders: num(zone.orders), boxes: num(zone.boxes), stops: num(zone.stops) })),
      vehicles: list(day.vehicles).map((vehicle): VehicleDay => ({
        vehicleId: str(vehicle.vehicleId), plate: str(vehicle.plate), label: str(vehicle.label), driver: strOrNull(vehicle.driver),
        stops: num(vehicle.stops), boxes: num(vehicle.boxes), orders: num(vehicle.orders), stopsDone: num(vehicle.stopsDone),
        boxesDelivered: num(vehicle.boxesDelivered), ordersDone: num(vehicle.ordersDone), stopsSkipped: num(vehicle.stopsSkipped),
        departedAt: strOrNull(vehicle.departedAt), lastArrivedAt: strOrNull(vehicle.lastArrivedAt), finishedAt: strOrNull(vehicle.finishedAt),
        driveMinutes: numOrNull(vehicle.driveMinutes), distanceKm: numOrNull(vehicle.distanceKm), boxesPerStop: num(vehicle.boxesPerStop),
        minutesPerStop: numOrNull(vehicle.minutesPerStop),
        incentive: record(vehicle.incentive) ? { target: num(vehicle.incentive.target), delivered: num(vehicle.incentive.delivered), excess: num(vehicle.incentive.excess), amount: num(vehicle.incentive.amount) } : null,
      })),
    })),
  };
}

const utcDay = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** The key of the period a date falls in: the date itself, the Monday of its week, or its month. */
export function periodKey(date: string, grain: Grain): string {
  if (grain === 'day') return date;
  if (grain === 'month') return date.slice(0, 7);
  const weekday = new Date(utcDay(date)).getUTCDay();
  return new Date(utcDay(date) - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

export const periodLabel = (key: string, grain: Grain): string => (grain === 'week' ? `${key} 주` : key);
const round1 = (value: number): number => Math.round(value * 10) / 10;

export function groupPeriods(days: DayRow[], grain: Grain): Period[] {
  const groups = new Map<string, DayRow[]>();
  for (const day of days) {
    if (day.error) continue;
    const key = periodKey(day.date, grain);
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]): Period => {
    const boxes = rows.reduce((sum, row) => sum + row.boxes, 0);
    const stops = rows.reduce((sum, row) => sum + row.stops, 0);
    const paid = rows.filter(row => row.incentive);
    return {
      key, days: rows.length, orders: rows.reduce((sum, row) => sum + row.orders, 0), boxes: round1(boxes), stops,
      boxesPerStop: stops ? round1(boxes / stops) : null,
      vehicles: rows.reduce((sum, row) => sum + row.vehicles.length, 0),
      boxesDelivered: round1(rows.reduce((sum, row) => sum + row.vehicles.reduce((inner, vehicle) => inner + vehicle.boxesDelivered, 0), 0)),
      // A period where no day had a rule to apply shows no fee at all rather than 0 won.
      incentive: paid.length ? { people: paid.reduce((sum, row) => sum + row.incentive!.people, 0), amount: paid.reduce((sum, row) => sum + row.incentive!.amount, 0) } : null,
    };
  });
}

export function zoneTotals(days: DayRow[]): { zoneId: string; orders: number; boxes: number; stops: number }[] {
  const totals = new Map<string, { zoneId: string; orders: number; boxes: number; stops: number }>();
  for (const zone of days.flatMap(day => day.zones)) {
    const current = totals.get(zone.zoneId) ?? { zoneId: zone.zoneId, orders: 0, boxes: 0, stops: 0 };
    totals.set(zone.zoneId, { zoneId: zone.zoneId, orders: current.orders + zone.orders, boxes: round1(current.boxes + zone.boxes), stops: current.stops + zone.stops });
  }
  return [...totals.values()].sort((a, b) => b.boxes - a.boxes || a.zoneId.localeCompare(b.zoneId));
}

export const unitLabel = (unit: Rules['unit']): string => ({ boxes: '박스', stops: '착지', orders: '주문' })[unit];

export function rulesText(dashboard: Dashboard): string {
  if (dashboard.rulesError) return '추가 수수료 규칙 파일(incentive-rules.json)을 읽을 수 없어 수수료를 계산하지 않았습니다. 파일 형식을 확인해 주세요.';
  const rules = dashboard.rules;
  if (!rules) return '추가 수수료 규칙(incentive-rules.json)이 없어 수수료를 계산하지 않았습니다. 설정 방법은 운영 런북에 있습니다.';
  const own = Object.keys(rules.targetsByDriver).length;
  return `추가 수수료: 하루 ${rules.dailyTarget.toLocaleString('ko-KR')}${unitLabel(rules.unit)}를 넘은 ${unitLabel(rules.unit)}마다 ${rules.ratePerUnit.toLocaleString('ko-KR')}원${own ? `(기사 ${own}명은 개인 목표)` : ''}. 완료한 ${unitLabel(rules.unit)} 기준입니다.`;
}

export const clock = (iso: string | null): string => {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? '—' : new Date(time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
};
