import type { OutboxItem } from '../outbox/Outbox';
import type { Stop } from './dispatch';
import { STOP_EVENT_TYPES } from './stopEvents';

/**
 * What the screen shows while events are still on the phone: a stop with a queued (or just sent, not yet reread)
 * completion is closed at once and the next waiting stop becomes the current one. A rejected event does not close
 * its stop, so the stop shows as open again until the driver decides. `queued` holds the keys of the closed stops
 * that the server has not confirmed yet.
 */
export function applyOutbox(stops: readonly Stop[], items: readonly OutboxItem[]): { stops: Stop[]; queued: Set<string> } {
  const closing = new Map<string, 'done' | 'skipped'>();
  const queued = new Set<string>();
  for (const item of items) {
    if (item.state === 'rejected' || !STOP_EVENT_TYPES.includes(item.type)) continue;
    const stop = stops.find((candidate) => candidate.orders.some((order) => order.id === item.stopId));
    if (!stop) continue;
    closing.set(stop.key, item.type === 'stop_failed' ? 'skipped' : 'done');
    if (item.state !== 'sent') queued.add(stop.key);
  }
  const shown = stops.map((stop) => {
    const status = closing.get(stop.key);
    return status ? { ...stop, status, arrived: false } : stop;
  });
  if (closing.size > 0 && !shown.some((stop) => stop.status === 'current')) {
    const next = shown.findIndex((stop) => stop.status === 'pending');
    if (next >= 0) shown[next] = { ...shown[next], status: 'current' };
  }
  return { stops: shown, queued };
}
