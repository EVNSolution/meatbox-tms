import assert from 'node:assert/strict';
import test from 'node:test';
import { createFidRegistrationWorker, createLatestSerialQueue } from './fid-sync.mjs';
import { StaleSessionError, createSessionGate } from './session-state.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('FID sync serializes requests and coalesces pending callbacks to the latest FID', async () => {
  const gates = [deferred(), deferred()];
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const queue = createLatestSerialQueue(async fid => {
    calls.push(fid);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await gates[calls.length - 1].promise;
    inFlight -= 1;
    return fid;
  });
  const first = queue.enqueue('fid-old');
  const middle = queue.enqueue('fid-middle');
  const latest = queue.enqueue('fid-latest');
  gates[0].resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  gates[1].resolve();
  assert.deepEqual(await Promise.all([middle, latest]), ['fid-latest', 'fid-latest']);
  assert.deepEqual(calls, ['fid-old', 'fid-latest']);
  assert.equal(maxInFlight, 1);
});

test('a failed request does not discard the latest pending FID', async () => {
  const gate = deferred();
  const calls = [];
  const queue = createLatestSerialQueue(async fid => {
    calls.push(fid);
    if (fid === 'fid-old') { await gate.promise; throw new Error('old failed'); }
    return fid;
  });
  const old = queue.enqueue('fid-old');
  const latest = queue.enqueue('fid-latest');
  gate.resolve();
  await assert.rejects(old, /old failed/);
  assert.equal(await latest, 'fid-latest');
  assert.deepEqual(calls, ['fid-old', 'fid-latest']);
});

test('registration sends expected version and safely retries one CAS conflict after refresh', async () => {
  let version = 1;
  const bodies = [];
  const worker = createFidRegistrationWorker({
    put:async body => {
      bodies.push(body);
      if (bodies.length === 1) throw Object.assign(new Error('conflict'), { status:409, code:'fid_version_conflict' });
      return { fidVersion:3 };
    },
    refreshVersion:async () => { version = 2; },
    getVersion:() => version,
    setVersion:value => { version = value; },
  });
  assert.deepEqual(await worker('fid-latest'), { fidVersion:3 });
  assert.deepEqual(bodies, [
    { fid:'fid-latest', expectedFidVersion:1 },
    { fid:'fid-latest', expectedFidVersion:2 },
  ]);
  assert.equal(version, 3);
});

test('bootstrap retries preserve one key and successful registration can clear it', async () => {
  let version = null;
  let cleared = '';
  const bodies = [];
  const input = { fid:'fid-new', bootstrapKey:'bootstrap-stable' };
  const worker = createFidRegistrationWorker({
    put:async body => {
      bodies.push(body);
      if (bodies.length === 1) throw Object.assign(new Error('lost bootstrap response'), { status:409, code:'installation_bootstrap_conflict' });
      return { fidVersion:1 };
    },
    refreshVersion:async () => {},
    getVersion:() => version,
    setVersion:value => { version = value; },
    buildBody:(item, expectedFidVersion) => ({ fid:item.fid, expectedFidVersion, bootstrapKey:item.bootstrapKey }),
  });
  await worker(input);
  cleared = input.bootstrapKey;
  assert.deepEqual(bodies, [
    { fid:'fid-new', expectedFidVersion:0, bootstrapKey:'bootstrap-stable' },
    { fid:'fid-new', expectedFidVersion:0, bootstrapKey:'bootstrap-stable' },
  ]);
  assert.equal(cleared, 'bootstrap-stable');
});

test('an expired bootstrap proof rotates once and retries as a new installation', async () => {
  let version = null;
  let rotations = 0;
  const bodies = [];
  const input = { fid:'fid-new', bootstrapKey:'bootstrap-expired' };
  const worker = createFidRegistrationWorker({
    put:async body => {
      bodies.push({ ...body });
      if (bodies.length === 1) throw Object.assign(new Error('two minute recovery expired'), { status:410, code:'bootstrap_retry_expired' });
      return { fidVersion:1 };
    },
    refreshVersion:async () => {}, getVersion:() => version,
    setVersion:value => { version = value; },
    buildBody:(item, expectedFidVersion) => ({ fid:item.fid, expectedFidVersion, bootstrapKey:item.bootstrapKey }),
    rotateBootstrap:item => { rotations += 1; item.bootstrapKey = 'bootstrap-rotated'; return item; },
  });
  await worker(input);
  assert.deepEqual(bodies, [
    { fid:'fid-new', expectedFidVersion:0, bootstrapKey:'bootstrap-expired' },
    { fid:'fid-new', expectedFidVersion:0, bootstrapKey:'bootstrap-rotated' },
  ]);
  assert.equal(rotations, 1);
  assert.equal(version, 1);
});

test('a second bootstrap expiry is explicit and never loops', async () => {
  let calls = 0, rotations = 0;
  const worker = createFidRegistrationWorker({
    put:async () => { calls += 1; throw Object.assign(new Error('expired'), { status:410, code:'bootstrap_retry_expired' }); },
    refreshVersion:async () => {}, getVersion:() => null, setVersion:() => {},
    rotateBootstrap:item => { rotations += 1; return { ...item, bootstrapKey:'new-key' }; },
  });
  await assert.rejects(worker({ fid:'fid-new', bootstrapKey:'old-key' }), /expired/);
  assert.equal(calls, 2);
  assert.equal(rotations, 1);
});

test('closing a session cancels queued old FIDs and never sends them with the new generation', async () => {
  const gate = createSessionGate();
  const oldGeneration = gate.begin();
  const slow = deferred();
  const calls = [];
  let version = 0;
  const worker = createFidRegistrationWorker({
    put:async (body, input) => { calls.push({ body, generation:input.generation, projectId:input.projectId }); if (input.fid === 'old-running') await slow.promise; return { fidVersion:version + 1 }; },
    refreshVersion:async () => {}, getVersion:() => version,
    setVersion:value => { version = value; }, assertCurrent:input => gate.assert(input.generation),
  });
  const queue = createLatestSerialQueue(worker);
  const running = queue.enqueue({ fid:'old-running', generation:oldGeneration, projectId:'old-project' });
  const cancelled = queue.enqueue({ fid:'old-queued', generation:oldGeneration, projectId:'old-project' });
  const runningCheck = assert.rejects(running, StaleSessionError);
  const cancelledCheck = assert.rejects(cancelled, StaleSessionError);
  gate.close();
  queue.cancelPending(new StaleSessionError());
  const nextGeneration = gate.begin();
  const current = queue.enqueue({ fid:'new-current', generation:nextGeneration, projectId:'new-project' });
  slow.resolve();
  await runningCheck;
  await cancelledCheck;
  assert.equal((await current).fidVersion, 1);
  assert.deepEqual(calls.map(call => [call.body.fid, call.generation, call.projectId]), [
    ['old-running', oldGeneration, 'old-project'],
    ['new-current', nextGeneration, 'new-project'],
  ]);
});
