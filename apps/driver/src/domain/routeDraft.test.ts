import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DriverRoute, RouteSuggestion } from '../api/driverContracts';
import { groupStops, type FleetDelivery } from './dispatch';
import { serverStopOrder, suggestedKeys, suggestionSummary } from './routeDraft';

const delivery = (id: string, name: string, status: FleetDelivery['status'] = 'pending'): FleetDelivery => ({
  id, vehicleId: 'G1', name, address: `${name} 주소`, boxes: 1, sequence: Number(id.slice(1)), status, coordinates: [127, 37.5],
});
const stops = groupStops([delivery('O1', 'A'), delivery('O2', 'A'), delivery('O3', 'B'), delivery('O4', 'C')]);
const route = (statuses: ('pending' | 'current' | 'done' | 'skipped')[] = ['pending', 'pending', 'pending']): DriverRoute => ({
  date: '2026-11-02', vehicleId: 'G1', revision: 7, phase: 'idle', next: null,
  dispatchPhase: 'published', operable: true, vehicle: { vehicleId: 'G1', label: null, plate: null, region: null },
  stops: [['O1', ['O1', 'O2']], ['O3', ['O3']], ['O4', ['O4']]].map(([stopId, orderIds], index) => ({
    stopId: stopId as string, sequence: index + 1, orderIds: orderIds as string[], name: '', address: '', boxes: 1,
    status: statuses[index], eta: null, estimated: null, coordinates: null, orders: [],
  })),
});
const suggestion = (stopOrder: string[]): RouteSuggestion => ({
  vehicleId: 'G1', revision: 7, stopOrder, changed: true, totalMinutes: 41, totalKm: 12.3, placed: [],
});

test('a suggestion becomes app stop keys in the proposed order', () => {
  assert.deepEqual(suggestedKeys(stops, suggestion(['O4', 'O1', 'O3']), route()), [stops[2].key, stops[0].key, stops[1].key]);
});

test('a suggestion that misses, repeats or invents a stop is refused', () => {
  assert.equal(suggestedKeys(stops, suggestion(['O4', 'O1']), route()), null);
  assert.equal(suggestedKeys(stops, suggestion(['O4', 'O4', 'O1']), route()), null);
  assert.equal(suggestedKeys(stops, suggestion(['O4', 'O1', 'O9']), route()), null);
  assert.equal(suggestedKeys(stops, suggestion(['O4', 'O1', 'O3']), { ...route(), stops: route().stops.slice(0, 2) }), null);
});

test('the event stopOrder lists server stop IDs with the edited order in the pending slots', () => {
  assert.deepEqual(serverStopOrder([stops[2].key, stops[0].key, stops[1].key], stops, route()), ['O4', 'O1', 'O3']);
  // A done stop keeps its place; the pending ones swap.
  const withDone = groupStops([delivery('O1', 'A', 'done'), delivery('O2', 'A', 'done'), delivery('O3', 'B'), delivery('O4', 'C')]);
  assert.deepEqual(serverStopOrder([withDone[2].key, withDone[1].key], withDone, route(['done', 'pending', 'pending'])), ['O1', 'O4', 'O3']);
});

test('an edit that drops, repeats or invents a stop cannot be sent', () => {
  assert.throws(() => serverStopOrder([stops[0].key, stops[1].key], stops, route()));
  assert.throws(() => serverStopOrder([stops[0].key, stops[0].key, stops[1].key], stops, route()));
  assert.throws(() => serverStopOrder([stops[0].key, stops[1].key, 'unknown'], stops, route()));
});

test('the summary shows minutes and km, and how many stops had no coordinates', () => {
  assert.equal(suggestionSummary(suggestion([])), '예상 41분 · 12.3km');
  const placed = { ...suggestion([]), placed: [{ stopId: 'O3', placed: 'no-coordinates' as const, afterStopId: null }] };
  assert.equal(suggestionSummary(placed), '예상 41분 · 12.3km · 좌표 없는 1곳은 뒤쪽에 두었습니다');
});

test('after the departure the current and the finished stops keep their place and only the waiting ones swap', () => {
  const running = groupStops([delivery('O1', 'A', 'done'), delivery('O2', 'A', 'done'), delivery('O3', 'B', 'current'), delivery('O4', 'C', 'pending')]);
  const mid = route(['done', 'current', 'pending']);
  // O1 done, O3 current, O4 waiting: nothing but O4 can move, so the only valid order is the one it already has.
  assert.deepEqual(serverStopOrder([running[2].key], running, mid), ['O1', 'O3', 'O4']);
  assert.throws(() => serverStopOrder([running[1].key], running, mid));
  const more = groupStops([delivery('O1', 'A', 'done'), delivery('O2', 'A', 'done'), delivery('O3', 'B', 'pending'), delivery('O4', 'C', 'pending')]);
  assert.deepEqual(serverStopOrder([more[2].key, more[1].key], more, route(['done', 'pending', 'pending'])), ['O1', 'O4', 'O3']);
  // A suggestion that only reorders the waiting stops maps to the waiting app stops.
  const keys = suggestedKeys(more.filter((stop) => stop.status === 'pending'), suggestion(['O1', 'O4', 'O3']), route(['done', 'pending', 'pending']));
  assert.deepEqual(keys, [more[2].key, more[1].key]);
});
