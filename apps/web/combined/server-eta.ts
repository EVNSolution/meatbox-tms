import { clockText } from './temperature-model.ts';

// The arrival times the server computes once the driver app reports a departure (`vehicleStates[v].eta`). They are shown
// beside the plan estimate the screen always had, and never replace it before the driver has left.

export type EtaStop = { stopId: string; sequence: number | null; eta: string; estimated: boolean; actualAt: string | null };
export type ServerEta = {
  computedAt: string; reason: string; departedAt: string | null; departureTimeSource: 'device' | 'server' | null; recomputes: number; stops: EtaStop[];
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function readEta(raw: unknown): ServerEta | null {
  if (!record(raw) || !text(raw.computedAt) || !Array.isArray(raw.stops)) return null;
  const stops = raw.stops.flatMap((item: unknown): EtaStop[] => {
    if (!record(item) || !text(item.stopId) || !text(item.eta) || !Number.isFinite(Date.parse(item.eta))) return [];
    return [{ stopId: item.stopId, sequence: typeof item.sequence === 'number' ? item.sequence : null, eta: item.eta, estimated: item.estimated !== false, actualAt: text(item.actualAt) ? item.actualAt : null }];
  });
  return {
    computedAt: raw.computedAt, reason: typeof raw.reason === 'string' ? raw.reason : '',
    departedAt: text(raw.departedAt) ? raw.departedAt : null,
    departureTimeSource: raw.departureTimeSource === 'device' || raw.departureTimeSource === 'server' ? raw.departureTimeSource : null,
    recomputes: typeof raw.recomputes === 'number' ? raw.recomputes : 0, stops,
  };
}

/** The ETA of a delivery bundle: the server names a stop by one of its orders. */
export function etaFor(eta: ServerEta | null, stop: { id?: string; orderIds?: string[] } | null | undefined): EtaStop | null {
  if (!eta || !stop) return null;
  const ids = new Set([stop.id, ...(stop.orderIds ?? [])].filter((id): id is string => typeof id === 'string'));
  return eta.stops.find(item => ids.has(item.stopId)) ?? null;
}

export function etaText(entry: EtaStop): string {
  const planned = `${clockText(entry.eta)}${entry.estimated ? '' : ' (위치 미확인)'}`;
  return entry.actualAt ? `예정 ${planned} · 실제 ${clockText(entry.actualAt)}` : planned;
}

const reasons: Record<string, string> = { departed: '출발', zone_entered: '권역 진입', reordered: '순서 변경', delayed: '지연', completed: '배송지 완료' };

export function etaNote(eta: ServerEta): string {
  const from = eta.departedAt ? `출발 ${clockText(eta.departedAt)}${eta.departureTimeSource === 'device' ? '(기기 시각)' : eta.departureTimeSource === 'server' ? '(서버 수신 시각)' : ''}, ` : '';
  const why = reasons[eta.reason] ? `, 사유 ${reasons[eta.reason]}` : '';
  return `서버 ETA: ${from}산출 ${clockText(eta.computedAt)}, 재산출 ${eta.recomputes}회${why}. 직선거리 모델이라 실제 도로와 다를 수 있습니다.`;
}
