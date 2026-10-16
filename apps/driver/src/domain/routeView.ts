import type { DriverRoute, RouteStopSummary, StopDetail } from '../api/driverContracts';
import type { Stop } from './dispatch';

// Joins what the date state shows (names, coordinates, status) with what the driver route adds (ETA, stop IDs).

/** The server's stop for this app stop: the one that holds the app stop's first order. */
export function serverStop(stop: Stop, route: DriverRoute | null): RouteStopSummary | null {
  const first = stop.orders[0]?.id;
  return route?.stops.find((candidate) => first !== undefined && candidate.orderIds.includes(first)) ?? null;
}

export type EtaLabel = { text: string; dimmed: boolean };

// Asia/Seoul has no DST, so a fixed +9h shift is exact. The server already sends +09:00 times.
function seoulClock(iso: string): string | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 9 * 3_600_000).toISOString().slice(11, 16) : null;
}

/**
 * The arrival time of a stop. Before the departure there is none. `estimated: false` means no travel time was
 * added (a stop without coordinates), so the time is shown dimmed and says so.
 */
export function etaLabel(stop: Stop, route: DriverRoute | null): EtaLabel | null {
  if (stop.status === 'done' || stop.status === 'skipped') return null;
  const entry = serverStop(stop, route);
  const clock = entry?.eta ? seoulClock(entry.eta) : null;
  if (!entry || !clock) return null;
  return entry.estimated === false
    ? { text: `${clock} · 이동 시간 미반영`, dimmed: true }
    : { text: `도착 ${clock}`, dimmed: false };
}

/** Keys of the stops whose pin is drawn dimmed on the map. */
export function dimmedStopKeys(stops: readonly Stop[], route: DriverRoute | null): Set<string> {
  return new Set(stops.filter((stop) => etaLabel(stop, route)?.dimmed).map((stop) => stop.key));
}

export type DetailSection = { title: string; lines: string[] };

function plain(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function labelled(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(labelled);
  const text = plain(value);
  if (text) return [text];
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) return labelled(record.items);
    return [plain(record.label) ?? plain(record.name) ?? plain(record.body)].filter((line): line is string => !!line);
  }
  return [];
}

function itemLine(item: unknown): string[] {
  if (item === null || typeof item !== 'object') return labelled(item);
  const record = item as Record<string, unknown>;
  const name = plain(record.name) ?? plain(record.sku);
  if (!name) return [];
  const qty = plain(record.qty);
  return [qty ? `${name} × ${qty}` : name];
}

function tipLines(tip: unknown): string[] {
  if (tip === null || typeof tip !== 'object') return labelled(tip);
  const record = tip as Record<string, unknown>;
  const body = plain(record.body);
  const author = plain(record.author);
  return body ? [author ? `${body} (${author})` : body] : [];
}

function accessLines(access: unknown): string[] {
  if (access === null || typeof access !== 'object') return [];
  const record = access as Record<string, unknown>;
  const code = plain(record.entranceCode);
  const note = plain(record.placeNote);
  return [...(code ? [`출입 코드 ${code}`] : []), ...(note ? [note] : [])];
}

/** The detail sections of a stop, one line per fact. A section with no line is left out. */
export function detailSections(detail: StopDetail): DetailSection[] {
  const each = (pick: (order: StopDetail['orders'][number]) => string[]) => [...new Set(detail.orders.flatMap(pick))];
  const sections: DetailSection[] = [
    { title: '고객 요청', lines: each((order) => labelled(order.customerRequests)) },
    { title: '배송팁', lines: each((order) => tipLines(order.tip)) },
    { title: '출입 정보', lines: each((order) => accessLines(order.access)) },
    { title: '운송 조건', lines: each((order) => labelled(order.transportConditions)) },
    {
      title: '품목',
      lines: detail.orders.flatMap((order) =>
        (Array.isArray(order.items) ? order.items : []).flatMap(itemLine)),
    },
  ];
  return sections.filter((section) => section.lines.length > 0);
}
