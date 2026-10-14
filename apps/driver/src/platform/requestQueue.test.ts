import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestGate, SerialQueue } from './requestQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('10-second poll ticks do not replace a response that takes 15 seconds', async () => {
  const gate = new RequestGate();
  const network = deferred();
  let requests = 0;
  let displayed = '';
  const read = async () => { requests += 1; await network.promise; displayed = 'server response'; };
  const atZero = gate.run('state:today', read);
  await Promise.resolve();
  // The interval fires while the original network response remains pending.
  const atTenSeconds = gate.run('state:today', read);
  assert.equal(requests, 1);
  assert.equal(atTenSeconds, atZero);
  network.resolve();
  await atTenSeconds;
  assert.equal(displayed, 'server response');
});

test('explicit refresh after a mutation runs once after the outstanding read', async () => {
  const gate = new RequestGate();
  const stale = deferred();
  const responses: string[] = [];
  const initial = gate.run('state', async () => { await stale.promise; responses.push('stale'); });
  const firstRefresh = gate.run('state', async () => { responses.push('new'); }, true);
  const secondRefresh = gate.run('state', async () => { responses.push('duplicate'); }, true);
  stale.resolve();
  await Promise.all([initial, firstRefresh, secondRefresh]);
  assert.deepEqual(responses, ['stale', 'new']);
});

test('new vehicle reads are independent while their predecessor is still pending', async () => {
  const gate = new RequestGate();
  const old = deferred();
  const previous = gate.run('messages:old', () => old.promise);
  let nextReady = false;
  await gate.run('messages:new', async () => { nextReady = true; });
  assert.equal(nextReady, true);
  old.resolve(); await previous;
});

test('module-owned registration queue serializes work across remounts and survives failure', async () => {
  const queue = new SerialQueue();
  const old = deferred();
  const order: string[] = [];
  const previousMount = queue.run(async () => { order.push('old starts'); await old.promise; order.push('old ends'); throw new Error('old request failed'); });
  const nextMount = queue.run(async () => { order.push('new registers'); return 'ready'; });
  await Promise.resolve();
  assert.deepEqual(order, ['old starts']);
  old.resolve();
  await assert.rejects(previousMount);
  assert.equal(await nextMount, 'ready');
  assert.deepEqual(order, ['old starts', 'old ends', 'new registers']);
});
