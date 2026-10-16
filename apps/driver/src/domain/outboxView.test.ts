import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { OutboxItem } from '../outbox/Outbox';
import { groupStops, type FleetDelivery } from './dispatch';
import { applyOutbox } from './outboxView';

const delivery = (id: string, name: string, status: FleetDelivery['status']): FleetDelivery => ({
  id, vehicleId: 'G1', name, address: `${name} 주소`, boxes: 1, sequence: Number(id.slice(1)), status,
});
const stops = groupStops([delivery('O1', 'A', 'current'), delivery('O2', 'A', 'current'), delivery('O3', 'B', 'pending'), delivery('O4', 'C', 'pending')]);
const queued = (stopId: string, type: string, state: OutboxItem['state'] = 'pending'): OutboxItem => ({
  eventId: `e-${stopId}`, occurredAt: '', date: '2026-11-02', vehicleId: 'G1', type, stopId, payload: {}, photos: [],
  attempts: 0, nextAt: 0, state, uncertain: false, reason: null, reasonStatus: null, reply: null,
});
const statuses = (shown: { stops: { status: string }[] }) => shown.stops.map((stop) => stop.status);

test('a queued completion closes its stop at once and the next waiting stop becomes current', () => {
  const shown = applyOutbox(stops, [queued('O1', 'stop_completed')]);
  assert.deepEqual(statuses(shown), ['done', 'current', 'pending']);
  assert.deepEqual([...shown.queued], [stops[0].key]);
});

test('a queued failure shows as skipped; several queued stops advance step by step', () => {
  const shown = applyOutbox(stops, [queued('O1', 'stop_failed'), queued('O3', 'stop_partially_completed')]);
  assert.deepEqual(statuses(shown), ['skipped', 'done', 'current']);
  assert.equal(shown.queued.size, 2);
});

test('a rejected event does not close its stop; a sent one stays closed but is no longer queued', () => {
  assert.deepEqual(statuses(applyOutbox(stops, [queued('O1', 'stop_completed', 'rejected')])), ['current', 'pending', 'pending']);
  const sent = applyOutbox(stops, [queued('O1', 'stop_completed', 'sent')]);
  assert.deepEqual(statuses(sent), ['done', 'current', 'pending']);
  assert.equal(sent.queued.size, 0);
});

test('other events and unknown stops change nothing, and the input is not modified', () => {
  const shown = applyOutbox(stops, [queued('O1', 'departed'), queued('ZZ', 'stop_completed')]);
  assert.deepEqual(statuses(shown), ['current', 'pending', 'pending']);
  assert.equal(stops[0].status, 'current');
});

test('an order of a bundle names its stop; the last stop leaves nothing current', () => {
  const last = applyOutbox(stops, [queued('O2', 'stop_completed'), queued('O3', 'stop_completed'), queued('O4', 'stop_completed')]);
  assert.deepEqual(statuses(last), ['done', 'done', 'done']);
});
