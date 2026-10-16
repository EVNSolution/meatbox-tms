import type { DriverRoute, RouteSuggestion } from '../api/driverContracts';
import type { Stop } from './dispatch';
import { serverStop } from './routeView';

// The order editor works on app stops (keyed by name+address); the server speaks in its own stop IDs.

/** The app stop keys in the order a suggestion proposes, for the stops in [editable]. Null if they do not match 1:1. */
export function suggestedKeys(
  editable: readonly Stop[],
  suggestion: RouteSuggestion,
  route: DriverRoute,
): string[] | null {
  const byServerId = new Map<string, string>();
  for (const stop of editable) {
    const entry = serverStop(stop, route);
    if (!entry) return null;
    byServerId.set(entry.stopId, stop.key);
  }
  const proposed = suggestion.stopOrder.filter((id) => byServerId.has(id));
  const complete = proposed.length === editable.length && new Set(proposed).size === editable.length;
  return complete ? proposed.map((id) => byServerId.get(id) as string) : null;
}

/**
 * The full `stopOrder` of a `route_reordered` event: the server's stops in their order, with the pending ones
 * replaced by [pendingKeys] in the edited order. Stops that are not pending keep their place.
 */
export function serverStopOrder(
  pendingKeys: readonly string[],
  stops: readonly Stop[],
  route: DriverRoute,
): string[] {
  const idByKey = new Map<string, string>();
  for (const stop of stops) {
    const entry = serverStop(stop, route);
    if (entry) idByKey.set(stop.key, entry.stopId);
  }
  const queue = pendingKeys.map((key) => idByKey.get(key));
  const pending = route.stops.filter((stop) => stop.status === 'pending').length;
  const waiting = new Set(route.stops.filter((stop) => stop.status === 'pending').map((stop) => stop.stopId));
  // The edited list must be exactly the waiting stops: a closed stop in it would be duplicated and another lost.
  if (queue.length !== pending || queue.some((id) => id === undefined || !waiting.has(id)) || new Set(queue).size !== pending) {
    throw new Error('배송지 순서를 다시 확인해 주세요.');
  }
  return route.stops.map((stop) => (stop.status === 'pending' ? queue.shift() as string : stop.stopId));
}

/** One line for the editor after a suggestion: what the proposal costs and which stops had no coordinates. */
export function suggestionSummary(suggestion: RouteSuggestion): string {
  const base = `예상 ${suggestion.totalMinutes}분 · ${suggestion.totalKm}km`;
  const unplaced = suggestion.placed.length;
  return unplaced > 0 ? `${base} · 좌표 없는 ${unplaced}곳은 뒤쪽에 두었습니다` : base;
}
