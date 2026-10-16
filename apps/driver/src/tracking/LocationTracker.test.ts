import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../api/types';
import { MAX_BATCH, MAX_BUFFERED, RETAIN_MS, SEND_INTERVAL_MS } from '../domain/trackingPolicy';
import { LocationTracker, toSample, type Sample, type TrackingState } from './LocationTracker';

const DATE = '2026-11-02';
const START = Date.parse('2026-11-02T01:00:00.000Z');

function rig(sendOutcomes: unknown[] = []) {
  let saved: string | null = null;
  const state = { clock: START, sent: [] as { date: string; vehicleId: string; samples: Sample[] }[] };
  const tracker = new LocationTracker({
    load: async () => (saved ? (JSON.parse(saved) as TrackingState) : null),
    save: async (next) => { saved = next ? JSON.stringify(next) : null; },
    now: () => state.clock,
    send: async (date, vehicleId, samples) => {
      const outcome = sendOutcomes.length > 0 ? sendOutcomes.shift() : undefined;
      if (outcome instanceof Error) throw outcome;
      state.sent.push({ date, vehicleId, samples });
    },
  });
  return { tracker, state, saved: () => saved };
}
const reading = (offsetSeconds: number, latitude = 37.5, accuracy: number | null = 8) => ({
  coords: { latitude, longitude: 127, accuracy }, timestamp: START + offsetSeconds * 1000,
});

test('a reading becomes a server sample; broken readings are dropped', () => {
  assert.deepEqual(toSample(reading(0)), { at: '2026-11-02T01:00:00.000Z', lat: 37.5, lng: 127, accuracyM: 8 });
  assert.deepEqual(toSample(reading(0, 37.5, null)), { at: '2026-11-02T01:00:00.000Z', lat: 37.5, lng: 127 });
  assert.equal(toSample(reading(0, 91)), null);
  assert.equal(toSample({ coords: { latitude: Number.NaN, longitude: 127 }, timestamp: START }), null);
  assert.equal(toSample({ coords: { latitude: 37.5, longitude: 127 }, timestamp: Number.NaN }), null);
});

test('nothing is recorded or sent before tracking starts', async () => {
  const { tracker, state } = rig();
  assert.equal(await tracker.record([reading(0)]), 'idle');
  assert.equal(await tracker.current(), null);
  assert.equal(state.sent.length, 0);
});

test('samples wait until a minute has passed since the start, then go out in one batch', async () => {
  const { tracker, state } = rig();
  await tracker.start(DATE, 'G1');
  state.clock += 30_000;
  assert.equal(await tracker.record([reading(30)]), 'kept');
  assert.equal(state.sent.length, 0);
  state.clock += 30_000;
  assert.equal(await tracker.record([reading(60)]), 'sent');
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].vehicleId, 'G1');
  assert.deepEqual(state.sent[0].samples.map((sample) => sample.at), ['2026-11-02T01:00:30.000Z', '2026-11-02T01:01:00.000Z']);
  assert.equal(await tracker.waiting(), 0);
  state.clock += 30_000;
  assert.equal(await tracker.record([reading(90)]), 'kept');
  assert.equal(state.sent.length, 1);
});

test('a failed send keeps the samples and the next due time tries again with the old and new ones', async () => {
  const { tracker, state } = rig([new TypeError('offline')]);
  await tracker.start(DATE, 'G1');
  state.clock += SEND_INTERVAL_MS;
  assert.equal(await tracker.record([reading(60)]), 'kept');
  assert.equal(await tracker.waiting(), 1);
  state.clock += 30_000;
  assert.equal(await tracker.record([reading(90)]), 'kept');
  state.clock += 30_000;
  assert.equal(await tracker.record([reading(120)]), 'sent');
  assert.deepEqual(state.sent[0].samples.map((sample) => sample.at.slice(14, 19)), ['01:00', '01:30', '02:00']);
});

test('a sample read twice is kept once', async () => {
  const { tracker, state } = rig();
  await tracker.start(DATE, 'G1');
  await tracker.record([reading(10), reading(10), reading(20)]);
  assert.equal(await tracker.waiting(), 2);
  void state;
});

test('a batch holds at most 200 samples and a long offline stretch catches up in several batches', async () => {
  const { tracker, state } = rig();
  await tracker.start(DATE, 'G1');
  state.clock += SEND_INTERVAL_MS;
  const readings = Array.from({ length: 230 }, (_unused, index) => reading(index));
  await tracker.record(readings);
  assert.deepEqual(state.sent.map((entry) => entry.samples.length), [MAX_BATCH, 30]);
  assert.equal(await tracker.waiting(), 0);
});

test('samples older than an hour are dropped and the buffer never holds more than 240', async () => {
  const { tracker, state } = rig([new TypeError('offline'), new TypeError('offline')]);
  await tracker.start(DATE, 'G1');
  state.clock += SEND_INTERVAL_MS;
  await tracker.record([reading(-RETAIN_MS / 1000 - 10), reading(0)]);
  assert.equal(await tracker.waiting(), 1);
  const many = Array.from({ length: 300 }, (_unused, index) => reading(index * 2));
  state.clock += 600_000;
  await tracker.record(many);
  assert.equal(await tracker.waiting(), MAX_BUFFERED);
});

test('a lost session keeps the samples, a closed day or unknown vehicle ends tracking, an invalid batch is dropped', async () => {
  const auth = rig([new ApiError(401, 'LOGIN_REQUIRED')]);
  await auth.tracker.start(DATE, 'G1');
  auth.state.clock += SEND_INTERVAL_MS;
  assert.equal(await auth.tracker.record([reading(60)]), 'auth');
  assert.equal(await auth.tracker.waiting(), 1);

  const ended = rig([new ApiError(409, 'DRIVER_DATE_READ_ONLY')]);
  await ended.tracker.start(DATE, 'G1');
  ended.state.clock += SEND_INTERVAL_MS;
  assert.equal(await ended.tracker.record([reading(60)]), 'ended');
  assert.equal(await ended.tracker.current(), null);

  const gone = rig([new ApiError(404, 'DRIVER_VEHICLE_NOT_FOUND')]);
  await gone.tracker.start(DATE, 'G1');
  gone.state.clock += SEND_INTERVAL_MS;
  assert.equal(await gone.tracker.record([reading(60)]), 'ended');

  const invalid = rig([new ApiError(400, 'INVALID_INPUT')]);
  await invalid.tracker.start(DATE, 'G1');
  invalid.state.clock += SEND_INTERVAL_MS;
  await invalid.tracker.record([reading(60)]);
  assert.equal(await invalid.tracker.waiting(), 0);
  assert.notEqual(await invalid.tracker.current(), null);
});

test('stop sends what is left once, then forgets the scope; starting another scope flushes the old one first', async () => {
  const { tracker, state } = rig();
  await tracker.start(DATE, 'G1');
  await tracker.record([reading(10)]);
  assert.equal(state.sent.length, 0);
  assert.equal(await tracker.stop(), 'sent');
  assert.equal(state.sent.length, 1);
  assert.equal(await tracker.current(), null);
  assert.equal(await tracker.stop(), 'idle');

  await tracker.start(DATE, 'G1');
  await tracker.record([reading(20)]);
  await tracker.start(DATE, 'G2');
  assert.equal(state.sent.at(-1)?.vehicleId, 'G1');
  assert.deepEqual(await tracker.current(), { date: DATE, vehicleId: 'G2' });
  await tracker.start(DATE, 'G2');
  assert.equal(await tracker.waiting(), 0);
});

test('the same scope started again keeps its samples', async () => {
  const { tracker } = rig();
  await tracker.start(DATE, 'G1');
  await tracker.record([reading(10)]);
  await tracker.start(DATE, 'G1');
  assert.equal(await tracker.waiting(), 1);
});
