import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EventReply } from '../api/driverContracts';
import { ApiError } from '../api/types';
import { classify, Outbox, RETRY_DELAYS_MS, retryDelay, type NewOutboxItem, type OutboxItem, type OutboxPorts } from './Outbox';

const DATE = '2026-11-02';
const reply: EventReply = { accepted: true, duplicate: false, receivedAt: 'now', next: null };

type Script = { upload?: unknown[]; send?: unknown[]; lookup?: unknown[] };

// A fake device: storage that survives a "restart" (JSON round trip), a clock, and scripted network answers.
function device(script: Script = {}) {
  let saved = '[]';
  const state = {
    clock: 1_000_000,
    log: [] as string[],
    removed: [] as string[],
    missing: new Set<string>(),
    sentPayloads: [] as Record<string, unknown>[],
  };
  const answer = (queue: unknown[] | undefined, fallback: () => unknown) => {
    const next = queue && queue.length > 0 ? queue.shift() : fallback();
    if (next instanceof Error) throw next;
    return next;
  };
  const ports: OutboxPorts = {
    load: async () => JSON.parse(saved) as OutboxItem[],
    save: async (items) => { saved = JSON.stringify(items); },
    now: () => state.clock,
    photoReady: (path) => !state.missing.has(path),
    uploadPhoto: async (_date, path) => {
      state.log.push(`upload ${path}`);
      return answer(script.upload, () => ({ photoId: `id-${path}` })) as { photoId: string };
    },
    sendEvent: async (item, payload) => {
      state.log.push(`send ${item.eventId}`);
      state.sentPayloads.push(payload);
      return answer(script.send, () => reply) as EventReply;
    },
    lookupEvent: async (_date, eventId) => {
      state.log.push(`lookup ${eventId}`);
      return answer(script.lookup, () => null) as EventReply | null;
    },
    removePhotos: (item) => { state.removed.push(item.eventId); },
  };
  const open = async () => { const outbox = new Outbox(ports); await outbox.init(); return outbox; };
  return { state, ports, open, saved: () => saved };
}

const item = (eventId: string, photos: string[] = [], type = 'stop_completed'): NewOutboxItem => ({
  eventId, occurredAt: '2026-11-02T01:00:00.000Z', date: DATE, vehicleId: 'G1', type, stopId: `S-${eventId}`,
  payload: { stopId: `S-${eventId}`, note: 'n' }, photoPaths: photos,
});
const problem = (status: number, code: string) => new ApiError(status, code);

test('the retry waits are 5s, 15s, 45s, 2m, 5m and then 5m for good', () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [5_000, 15_000, 45_000, 120_000, 300_000]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(retryDelay), [5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000]);
});

test('errors are sorted: network, 408, 429 and 5xx retry; 409 and other 4xx stop the item', () => {
  assert.equal(classify(new TypeError('Network request failed')), 'retry');
  for (const status of [408, 429, 500, 502, 503]) assert.equal(classify(problem(status, 'X')), 'retry');
  for (const status of [400, 401, 403, 404, 409, 413, 415]) assert.equal(classify(problem(status, 'X')), 'reject');
});

test('photos go first, then the event carries their ids, and the item is sent in saved order', async () => {
  const d = device();
  const outbox = await d.open();
  await outbox.enqueue(item('a', ['pa1', 'pa2']));
  await outbox.enqueue(item('b', ['pb1']));
  const result = await outbox.drain();
  assert.equal(result.kind, 'idle');
  assert.deepEqual(d.state.log, ['upload pa1', 'upload pa2', 'send a', 'upload pb1', 'send b']);
  assert.deepEqual(d.state.sentPayloads[0], { stopId: 'S-a', note: 'n', photoIds: ['id-pa1', 'id-pa2'] });
  assert.deepEqual(outbox.list().map((entry) => entry.state), ['sent', 'sent']);
  assert.deepEqual(d.state.removed, ['a', 'b']);
  assert.equal(outbox.waitingCount(), 0);
  await outbox.pruneSent();
  assert.equal(outbox.list().length, 0);
});

test('an event without photos sends no photoIds', async () => {
  const d = device();
  const outbox = await d.open();
  await outbox.enqueue(item('a'));
  await outbox.drain();
  assert.equal('photoIds' in d.state.sentPayloads[0], false);
});

test('a failed send waits 5s, then 15s, and the items behind it wait too', async () => {
  const d = device({ send: [new TypeError('offline'), new TypeError('offline')] });
  const outbox = await d.open();
  await outbox.enqueue(item('a'));
  await outbox.enqueue(item('b'));
  const first = await outbox.drain();
  assert.deepEqual(first, { kind: 'waiting', nextAt: d.state.clock + 5_000 });
  assert.deepEqual((await outbox.step()), { kind: 'waiting', nextAt: d.state.clock + 5_000 });
  assert.equal(d.state.log.filter((line) => line === 'send b').length, 0);
  d.state.clock += 5_000;
  const second = await outbox.drain();
  assert.deepEqual(second, { kind: 'waiting', nextAt: d.state.clock + 15_000 });
  d.state.clock += 15_000;
  assert.equal((await outbox.drain()).kind, 'idle');
  assert.deepEqual(outbox.list().map((entry) => entry.state), ['sent', 'sent']);
});

test('after a lost answer the event is looked up first: found means sent, not found means send again', async () => {
  const lostThenSeen = device({ send: [new TypeError('lost')], lookup: [reply] });
  let outbox = await lostThenSeen.open();
  await outbox.enqueue(item('a'));
  await outbox.drain();
  lostThenSeen.state.clock += 5_000;
  assert.equal((await outbox.drain()).kind, 'idle');
  assert.deepEqual(lostThenSeen.state.log, ['send a', 'lookup a']);
  assert.equal(outbox.list()[0].state, 'sent');

  const lostThenUnseen = device({ send: [new TypeError('lost')], lookup: [null] });
  outbox = await lostThenUnseen.open();
  await outbox.enqueue(item('b'));
  await outbox.drain();
  lostThenUnseen.state.clock += 5_000;
  await outbox.drain();
  assert.deepEqual(lostThenUnseen.state.log, ['send b', 'lookup b', 'send b']);
  assert.equal(outbox.list()[0].state, 'sent');

  const lookupFails = device({ send: [new TypeError('lost')], lookup: [new TypeError('still offline')] });
  outbox = await lookupFails.open();
  await outbox.enqueue(item('c'));
  await outbox.drain();
  lookupFails.state.clock += 5_000;
  const waiting = await outbox.drain();
  assert.deepEqual(waiting, { kind: 'waiting', nextAt: lookupFails.state.clock + 15_000 });
});

test('an uploaded photo is not uploaded again after a failed send', async () => {
  const d = device({ send: [problem(503, 'DOWN')] });
  const outbox = await d.open();
  await outbox.enqueue(item('a', ['p1', 'p2']));
  await outbox.drain();
  d.state.clock += 5_000;
  await outbox.drain();
  assert.deepEqual(d.state.log.filter((line) => line.startsWith('upload')), ['upload p1', 'upload p2']);
});

test('a photo upload that fails keeps the photos already uploaded and does not send the event', async () => {
  const d = device({ upload: [{ photoId: 'one' }, new TypeError('offline')] });
  const outbox = await d.open();
  await outbox.enqueue(item('a', ['p1', 'p2']));
  await outbox.drain();
  assert.deepEqual(outbox.list()[0].photos.map((photo) => photo.photoId), ['one', null]);
  assert.equal(d.state.log.includes('send a'), false);
  assert.equal(outbox.list()[0].uncertain, false);
  d.state.clock += 5_000;
  await outbox.drain();
  assert.deepEqual(d.state.log.filter((line) => line.startsWith('upload')), ['upload p1', 'upload p2', 'upload p2']);
  assert.deepEqual(d.state.sentPayloads[0].photoIds, ['one', 'id-p2']);
});

test('400, 401, 403 and 413 reject the item and stop the queue until the driver acts', async () => {
  for (const status of [400, 401, 403, 413]) {
    const d = device({ send: [problem(status, `CODE_${status}`)] });
    const outbox = await d.open();
    await outbox.enqueue(item('a'));
    await outbox.enqueue(item('b'));
    const result = await outbox.drain();
    assert.equal(result.kind, 'blocked');
    assert.deepEqual(outbox.list().map((entry) => entry.state), ['rejected', 'pending']);
    assert.equal(outbox.list()[0].reason, `CODE_${status}`);
    assert.equal(outbox.list()[0].reasonStatus, status);
    assert.equal(outbox.rejectedCount(), 1);
    assert.equal(d.state.log.includes('send b'), false);
  }
});

test('a 409 rejects the item with its code so the screen can reread the server state', async () => {
  const d = device({ send: [problem(409, 'OPERATION_REVISION_CONFLICT')] });
  const outbox = await d.open();
  await outbox.enqueue(item('a'));
  assert.equal((await outbox.drain()).kind, 'blocked');
  assert.equal(outbox.list()[0].reason, 'OPERATION_REVISION_CONFLICT');
  assert.equal(outbox.list()[0].reasonStatus, 409);
});

test('discarding a rejected item deletes its photos and lets the queue go on; retrying sends it again', async () => {
  const d = device({ send: [problem(400, 'INVALID_INPUT'), problem(400, 'INVALID_INPUT')] });
  const outbox = await d.open();
  await outbox.enqueue(item('a', ['p1']));
  await outbox.enqueue(item('b'));
  await outbox.drain();
  await outbox.retryNow('a');
  assert.equal(outbox.list()[0].state, 'pending');
  await outbox.drain();
  assert.equal(outbox.list()[0].state, 'rejected');
  await outbox.discard('a');
  assert.deepEqual(d.state.removed, ['a']);
  assert.equal((await outbox.drain()).kind, 'idle');
  assert.deepEqual(outbox.list().map((entry) => [entry.eventId, entry.state]), [['b', 'sent']]);
});

test('a photo file that vanished rejects the item instead of retrying forever', async () => {
  const d = device();
  d.state.missing.add('gone');
  const outbox = await d.open();
  await outbox.enqueue(item('a', ['gone']));
  assert.equal((await outbox.drain()).kind, 'blocked');
  assert.equal(outbox.list()[0].reason, 'PHOTO_FILE_MISSING');
});

test('after a restart the queue is restored in order; a send that was cut off is looked up before it is repeated', async () => {
  const d = device({ send: [new TypeError('lost')] });
  const first = await d.open();
  await first.enqueue(item('a', ['p1']));
  await first.enqueue(item('b'));
  await first.drain();
  // The process dies while the retry is mid-send: the saved state says "uploading".
  const saved = JSON.parse(d.saved()) as OutboxItem[];
  saved[0] = { ...saved[0], state: 'uploading', nextAt: 0 };
  d.ports.save(saved);
  const second = await d.open();
  assert.deepEqual(second.list().map((entry) => [entry.eventId, entry.state, entry.uncertain]), [['a', 'pending', true], ['b', 'pending', false]]);
  assert.equal(second.waitingCount(), 2);
  assert.equal(second.photoCount(), 1);
  d.state.log.length = 0;
  await second.drain();
  assert.deepEqual(d.state.log, ['lookup a', 'send a', 'send b']);
});

test('the same event ID is queued only once', async () => {
  const d = device();
  const outbox = await d.open();
  await outbox.enqueue(item('a'));
  await outbox.enqueue(item('a'));
  assert.equal(outbox.list().length, 1);
});
