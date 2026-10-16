import type { HistoryItem } from '../api/driverContracts';
import type { Stop } from './dispatch';
import { seoulClock } from './routeView';
import { REASON_CODES } from './stopEvents';

export type HistoryRow = {
  key: string;
  name: string;
  result: string;
  tone: 'done' | 'partial' | 'failed';
  time: string | null;
  reason: string | null;
  note: string | null;
  photos: number;
};

const RESULT: Record<HistoryItem['result'], { label: string; tone: HistoryRow['tone'] }> = {
  completed: { label: '배송 완료', tone: 'done' },
  partially_completed: { label: '부분 완료', tone: 'partial' },
  failed: { label: '미배송', tone: 'failed' },
};

/** Today's finished stops, newest first, with the stop's name from the day state (the server item names it by ID). */
export function historyRows(items: readonly HistoryItem[], stops: readonly Stop[]): HistoryRow[] {
  const rows = items.map((item) => {
    const stop = stops.find((candidate) => candidate.orders.some((order) => order.id === item.stopId));
    const reason = item.reasonCode
      ? REASON_CODES.find((entry) => entry.code === item.reasonCode)?.label ?? item.reasonCode
      : null;
    return {
      at: item.completedAt ? Date.parse(item.completedAt) : Number.NEGATIVE_INFINITY,
      row: {
        key: item.stopId,
        name: stop?.name ?? item.stopId,
        result: RESULT[item.result].label,
        tone: RESULT[item.result].tone,
        time: item.completedAt ? seoulClock(item.completedAt) : null,
        reason,
        note: item.note?.trim() || null,
        photos: item.photoIds.length,
      } satisfies HistoryRow,
    };
  });
  return rows.sort((left, right) => right.at - left.at).map((entry) => entry.row);
}
