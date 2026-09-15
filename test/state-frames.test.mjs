import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createStateReceiver } from '../apps/combined/state-frames.mjs';

const require = createRequire(import.meta.url);
const { createStateFrames } = require('../lib/state-frames.js');

const delivery = (id, sequence, overrides = {}) => ({
  id,
  vehicleId: 'vehicle/arbitrary',
  sequence,
  name: `배송지 ${sequence}`,
  boxes: 2,
  eta: null,
  tip: null,
  ...overrides,
});

const stateWith = deliveries => ({
  phase: 'delivering',
  elapsed: 17,
  nullable: null,
  count: 0,
  fleet: {
    vehicles: [{ id: 'vehicle/arbitrary', plate: '서울 12가 3456' }],
    deliveries,
  },
});

const clone = value => JSON.parse(JSON.stringify(value));

test('a single delivery update at 4,550 stops produces a much smaller exact patch', () => {
  const source = Array.from({ length: 4_550 }, (_, index) => delivery(`stop:${index + 1}`, index + 1));
  const frames = createStateFrames('boot-volume');
  const receiver = createStateReceiver();

  const first = frames.publish(stateWith(source));
  const retainedFirst = receiver.receive(first.full);
  assert.equal(first.patch, null);

  const changed = clone(stateWith(source));
  changed.elapsed = 18;
  changed.fleet.deliveries[2_731].eta = 1_800_000_000_000;
  changed.fleet.deliveries[2_731].tip = { body: '후문 진입', updatedAt: 123 };
  const second = frames.publish(changed);

  assert.ok(second.patch, 'a delta should be available');
  assert.ok(Buffer.byteLength(second.patch) < Buffer.byteLength(second.full) / 100);
  const reconstructed = receiver.receive(second.patch);
  assert.deepEqual(reconstructed, JSON.parse(second.full).state);
  assert.equal(retainedFirst.elapsed, 17);
  assert.equal(retainedFirst.fleet.deliveries[2_731].eta, null);
});

test('encoder comparison is insulated from mutations after publish', () => {
  const frames = createStateFrames('boot-mutation');
  const source = stateWith(Array.from({ length: 100 }, (_, index) => delivery(index === 0 ? 'mutable' : `stable-${index}`, index + 1)));
  const first = frames.publish(source);

  source.fleet.deliveries[0].eta = 99;
  source.fleet.vehicles[0].plate = '부산 99바 9999';
  source.count = 4;
  assert.equal(JSON.parse(first.full).state.fleet.deliveries[0].eta, null);

  const second = frames.publish(source);
  assert.ok(second.patch);
  const patch = JSON.parse(second.patch);
  assert.equal(patch.changes.count, 4);
  assert.equal(patch.fleet.vehicles[0].plate, '부산 99바 9999');
  assert.equal(patch.deliveries.upsert[0].eta, 99);
});

test('delivery add, delete, and reorder preserve arbitrary IDs and exact array order', () => {
  const frames = createStateFrames('boot-order');
  const receiver = createStateReceiver();
  const original = stateWith([
    delivery('first/id', 1),
    delivery('한글 배송지', 2),
    delivery('third?x=1', 3),
  ]);
  receiver.receive(frames.publish(original).full);

  const next = stateWith([
    delivery('third?x=1', 1, { boxes: 0 }),
    delivery('new#stop', 2, { eta: null }),
    delivery('first/id', 3, { tip: null }),
  ]);
  const published = frames.publish(next);
  const patch = JSON.parse(published.patch);
  assert.deepEqual(patch.deliveries.remove, ['한글 배송지']);
  assert.deepEqual(patch.deliveries.order, ['third?x=1', 'new#stop', 'first/id']);
  assert.deepEqual(receiver.receive(published.patch), JSON.parse(published.full).state);
});

test('bulk same-order delivery updates reconstruct without membership scans changing order', () => {
  const frames = createStateFrames('boot-bulk');
  const receiver = createStateReceiver();
  const deliveries = Array.from({ length: 4_550 }, (_, index) => delivery(`bulk-${index}`, index + 1));
  receiver.receive(frames.publish(stateWith(deliveries)).full);

  const next = stateWith(deliveries.map((record, index) => ({ ...record, eta: 1_800_000_000_000 + index })));
  const published = frames.publish(next);
  assert.ok(published.patch);
  assert.equal(JSON.parse(published.patch).deliveries.order, undefined);
  assert.deepEqual(receiver.receive(published.patch), JSON.parse(published.full).state);
});

test('top-level and fleet removals preserve explicit null and zero', () => {
  const frames = createStateFrames('boot-removal');
  const receiver = createStateReceiver();
  const firstState = {
    ...stateWith([delivery('zero', 1, { boxes: 0 })]),
    removedTop: 'gone',
  };
  firstState.fleet.removedFleet = true;
  receiver.receive(frames.publish(firstState).full);

  const next = stateWith([delivery('zero', 1, { boxes: 0, eta: null })]);
  const published = frames.publish(next);
  const patch = JSON.parse(published.patch);
  assert.deepEqual(patch.removed, ['removedTop']);
  assert.deepEqual(patch.fleetRemoved, ['removedFleet']);
  assert.deepEqual(receiver.receive(published.patch), JSON.parse(published.full).state);
});

test('an own __proto__ JSON key remains data and does not change reconstructed prototypes', () => {
  const frames = createStateFrames('boot-special-key');
  const receiver = createStateReceiver();
  const first = stateWith(Array.from({ length: 100 }, (_, index) => delivery(`safe-${index}`, index + 1)));
  Object.defineProperty(first, '__proto__', { value: { version: 1 }, enumerable: true, writable: true, configurable: true });
  receiver.receive(frames.publish(first).full);

  const next = clone(first);
  next.__proto__ = { version: 2 };
  const published = frames.publish(next);
  assert.ok(published.patch);
  assert.equal(JSON.parse(published.patch).changes.__proto__.version, 2);

  const reconstructed = receiver.receive(published.patch);
  assert.equal(Object.getPrototypeOf(reconstructed), Object.prototype);
  assert.equal(Object.hasOwn(reconstructed, '__proto__'), true);
  assert.deepEqual(reconstructed.__proto__, { version: 2 });
  assert.deepEqual(reconstructed, JSON.parse(published.full).state);
});

test('fleet reset, removal, null, and unusable delivery IDs fall back to a full frame', () => {
  for (const next of [
    { phase: 'reset' },
    { phase: 'reset', fleet: null },
    { phase: 'reset', fleet: { vehicles: [], deliveries: [{ sequence: 1 }] } },
    { phase: 'reset', fleet: { vehicles: [], deliveries: [{ id: 'duplicate' }, { id: 'duplicate' }] } },
  ]) {
    const frames = createStateFrames('boot-reset');
    frames.publish(stateWith([delivery('one', 1)]));
    assert.equal(frames.publish(next).patch, null);
  }
});

test('receiver rejects a patch without its base, a missed base, and malformed delivery order', () => {
  const frames = createStateFrames('boot-errors');
  const first = frames.publish(stateWith([delivery('one', 1)]));
  const secondState = stateWith([delivery('one', 1, { eta: 10 })]);
  const second = frames.publish(secondState);
  const third = frames.publish(stateWith([delivery('one', 1, { eta: 20 })]));

  assert.throws(() => createStateReceiver().receive(second.patch), /base/i);

  const missed = createStateReceiver();
  missed.receive(first.full);
  assert.throws(() => missed.receive(third.patch), /revision/i);

  const malformed = createStateReceiver();
  malformed.receive(first.full);
  const message = JSON.parse(second.patch);
  message.deliveries.order = ['missing'];
  assert.throws(() => malformed.receive(JSON.stringify(message)), /order/i);
});

test('a fresh full frame reconnects after missed patches and unrelated messages are ignored', () => {
  const frames = createStateFrames('boot-reconnect');
  frames.publish(stateWith([delivery('one', 1)]));
  frames.publish(stateWith([delivery('one', 1, { eta: 10 })]));
  const current = frames.publish(stateWith([delivery('one', 1, { eta: 20 })]));

  const receiver = createStateReceiver();
  assert.equal(receiver.receive(JSON.stringify({ type: 'error', code: 'NOPE' })), null);
  assert.deepEqual(receiver.receive(current.full), JSON.parse(current.full).state);
});

test('receiver accepts a legacy full frame without revision during rolling migration', () => {
  const receiver = createStateReceiver();
  assert.deepEqual(
    receiver.receive(JSON.stringify({ type: 'state', boot: 'legacy', state: { phase: 'delivering' } })),
    { phase: 'delivering' },
  );
});
