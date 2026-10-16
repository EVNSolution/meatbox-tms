// Temperature of the vehicles on the control screen: what the server reports and how it is classified and shown.
// The server decides `stale` (no value for the configured minutes) and `outOfRange` (three readings in a row); the
// screen only names the state, orders vehicles by it and never invents a value.

export type TemperatureReading = { celsius: number; measuredAt: string; stale: boolean; outOfRange: boolean };
export type TemperatureKind = 'out' | 'stale' | 'normal' | 'none';
export type TemperatureTone = 'red' | 'amber' | 'green' | 'neutral';
export type TemperatureView = { kind: TemperatureKind; label: string; tone: TemperatureTone; valueText: string; text: string };

export type LatestRow = {
  vehicleId: string;
  sensorId: string;
  celsius: number;
  measuredAt: string;
  receivedAt: string;
  ageSeconds: number;
  stale: boolean;
  outOfRange: boolean;
  range: { min: number | null; max: number | null } | null;
  compartment: string | null;
};

type Vehicle = { id: string; plate?: string; driver?: string };
export type OverviewRow = {
  vehicleId: string;
  vehicle: Vehicle | null;
  latest: LatestRow | null;
  sensors: number;
  view: TemperatureView;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `vehicleStates[v].temperature` of the day state, or null when the vehicle sent nothing (or the date is not today). */
export function readTemperature(value: unknown): TemperatureReading | null {
  if (!record(value) || typeof value.celsius !== 'number' || !Number.isFinite(value.celsius) || typeof value.measuredAt !== 'string') return null;
  return { celsius: value.celsius, measuredAt: value.measuredAt, stale: value.stale === true, outOfRange: value.outOfRange === true };
}

export const formatCelsius = (value: number): string => `${value.toFixed(1).replace(/^-0\.0$/, '0.0')}°C`;

const seoulClock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function clockText(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? seoulClock.format(time) : '미확인';
}

export function agoText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '미확인';
  if (seconds < 60) return '방금';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}

const labels: Record<TemperatureKind, [string, TemperatureTone]> = {
  out: ['범위 밖', 'red'],
  stale: ['미수신', 'amber'],
  normal: ['정상', 'green'],
  none: ['정보 없음', 'neutral'],
};

export const kindOf = (reading: { stale: boolean; outOfRange: boolean } | null): TemperatureKind =>
  !reading ? 'none' : reading.outOfRange ? 'out' : reading.stale ? 'stale' : 'normal';

/** Out of range comes first even when the value is old: a silent sensor that was out of range is the worse case. */
export function temperatureView(reading: TemperatureReading | null): TemperatureView {
  const kind = kindOf(reading);
  const [label, tone] = labels[kind];
  const valueText = reading ? formatCelsius(reading.celsius) : '정보 없음';
  const text = reading ? `${valueText} ${label}${kind === 'stale' ? `, 마지막 수신 ${clockText(reading.measuredAt)}` : ''}` : label;
  return { kind, label, tone, valueText, text };
}

export const temperatureRank = (kind: TemperatureKind): number => ({ out: 0, stale: 1, normal: 2, none: 3 })[kind];

/** Vehicles that need a look first: out of range, then silent, then fine, then without data. Order is kept inside a group. */
export function sortByTemperature<T extends { vehicle: { id: string } }>(rows: T[], states: unknown): T[] {
  const kinds = new Map(rows.map(row => [row.vehicle.id, kindOf(readTemperature(stateOf(states, row.vehicle.id)))] as const));
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => temperatureRank(kinds.get(a.row.vehicle.id)!) - temperatureRank(kinds.get(b.row.vehicle.id)!) || a.index - b.index)
    .map(item => item.row);
}

export function stateOf(states: unknown, vehicleId: string): unknown {
  return record(states) && record(states[vehicleId]) ? (states[vehicleId] as Record<string, unknown>).temperature : null;
}

function readRange(value: unknown): LatestRow['range'] {
  if (!record(value)) return null;
  const bound = (item: unknown) => (typeof item === 'number' && Number.isFinite(item) ? item : null);
  return { min: bound(value.min), max: bound(value.max) };
}

export function parseLatest(payload: unknown): LatestRow[] {
  if (!record(payload) || !Array.isArray(payload.vehicles)) throw new TypeError('온도 응답을 확인할 수 없습니다.');
  return payload.vehicles.map((item: unknown): LatestRow => {
    if (!record(item) || typeof item.vehicleId !== 'string' || typeof item.sensorId !== 'string'
      || typeof item.celsius !== 'number' || !Number.isFinite(item.celsius)
      || typeof item.measuredAt !== 'string' || typeof item.receivedAt !== 'string'
      || typeof item.ageSeconds !== 'number' || typeof item.stale !== 'boolean' || typeof item.outOfRange !== 'boolean') {
      throw new TypeError('온도 응답을 확인할 수 없습니다.');
    }
    return {
      vehicleId: item.vehicleId, sensorId: item.sensorId, celsius: item.celsius, measuredAt: item.measuredAt,
      receivedAt: item.receivedAt, ageSeconds: item.ageSeconds, stale: item.stale, outOfRange: item.outOfRange,
      range: readRange(item.range), compartment: typeof item.compartment === 'string' ? item.compartment : null,
    };
  });
}

export function rangeText(range: LatestRow['range']): string {
  if (!range || (range.min === null && range.max === null)) return '범위 없음';
  if (range.min === null) return `${formatCelsius(range.max!)} 이하`;
  if (range.max === null) return `${formatCelsius(range.min)} 이상`;
  return `${formatCelsius(range.min)} ~ ${formatCelsius(range.max)}`;
}

/** One row per vehicle: the fleet of the day plus any vehicle that sent values. The worst sensor stands for the vehicle. */
export function overviewRows(fleet: Vehicle[], latest: LatestRow[]): OverviewRow[] {
  const byVehicle = new Map<string, LatestRow[]>();
  for (const row of latest) byVehicle.set(row.vehicleId, [...(byVehicle.get(row.vehicleId) ?? []), row]);
  const ids = [...new Set([...fleet.map(vehicle => vehicle.id), ...byVehicle.keys()])];
  const rows = ids.map((vehicleId, index): OverviewRow & { index: number } => {
    const sensors = [...(byVehicle.get(vehicleId) ?? [])]
      .sort((a, b) => temperatureRank(kindOf(a)) - temperatureRank(kindOf(b)) || Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
    const worst = sensors[0] ?? null;
    const view = worst ? temperatureView({ celsius: worst.celsius, measuredAt: worst.measuredAt, stale: worst.stale, outOfRange: worst.outOfRange })
      : { kind: 'none' as const, label: '수신 이력 없음', tone: 'neutral' as const, valueText: '-', text: '수신 이력 없음' };
    return { vehicleId, vehicle: fleet.find(vehicle => vehicle.id === vehicleId) ?? null, latest: worst, sensors: sensors.length, view, index };
  });
  return rows.sort((a, b) => temperatureRank(a.view.kind) - temperatureRank(b.view.kind) || a.index - b.index)
    .map(({ index: _index, ...row }) => row);
}
