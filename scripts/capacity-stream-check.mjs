import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createDemo } from '../server.js';
import { createStateReceiver } from '../apps/combined/state-frames.mjs';
import { capacityFixture } from './capacity-fixture.cjs';

const connections = Number(process.argv[2] || 130);
if (!Number.isSafeInteger(connections) || connections < 1 || connections > 500) throw new Error('Local benchmark supports 1–500 connections');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-capacity-stream-'));
const origin = 'http://127.0.0.1:32123';
const demo = createDemo({ origin, accessFile: path.join(dir, 'access.json') });
const sockets = [];
const abort = setTimeout(() => { console.error('Capacity stream check exceeded 60 seconds'); process.exitCode = 1; demo.close(); }, 60_000);
const receive = socket => new Promise((resolve, reject) => {
  const cleanup = () => { socket.off('message', message); socket.off('close', closed); socket.off('error', failed); };
  const failed = error => { cleanup(); reject(error); };
  const closed = () => failed(new Error('Connection closed before state'));
  const message = raw => {
    cleanup();
    try { resolve({ message: JSON.parse(raw), bytes: raw.byteLength }); }
    catch (error) { reject(error); }
  };
  socket.once('message', message); socket.once('close', closed); socket.once('error', failed);
});
try {
  const invite = await demo.access.issueInvite();
  await demo.access.register({ username: 'capacitybench', password: 'local-benchmark-only', invite });
  const { token } = await demo.access.login({ username: 'capacitybench', password: 'local-benchmark-only' });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  const state = capacityFixture();
  demo.sim.broadcast(state);
  const endpoint = `ws://127.0.0.1:${demo.server.address().port}/ws/simulation`;
  const initialStart = performance.now();
  const starts = [];
  for (let index = 0; index < connections; index++) {
    const socket = new WebSocket(endpoint, 'meatbox-state-v2', { headers: { origin, cookie: `meatbox_session=${token}` } });
    sockets.push(socket); starts.push(receive(socket));
  }
  const initial = await Promise.all(starts);
  const connectMs = performance.now() - initialStart;
  for (const result of initial) assert.equal(result.message.state.fleet.deliveries.length, 4550);
  const receiver = createStateReceiver();
  receiver.receive(initial[0].message);
  const initialBytes = initial.reduce((sum, item) => sum + item.bytes, 0);
  initial.length = 0;
  const updates = [];
  // One batch changes one delivery per vehicle. No artificial delays hide queueing.
  for (let iteration = 0; iteration < 10; iteration++) {
    const pending = sockets.map(receive);
    for (let vehicle = 0; vehicle < 130; vehicle++) {
      state.fleet.deliveries[vehicle * 35].tip = { body: `동시 갱신 ${iteration}`, author: '검증 배송원', updatedAt: iteration * 60_000 };
    }
    const started = performance.now();
    demo.sim.broadcast(state);
    const received = await Promise.all(pending);
    assert.deepEqual(receiver.receive(received[0].message), state);
    assert.ok(received.every(item => item.message.type === 'state_patch'));
    updates.push({ allReceivedMs: +(performance.now() - started).toFixed(2), bytesPerClient: received[0].bytes });
  }
  console.log(JSON.stringify({ node: process.version, connections, vehicles: 130, stops: 4550,
    initialAllReceivedMs: +connectMs.toFixed(2), initialTotalBytes: initialBytes,
    changesPerBatch: 130, batches: updates,
    rssMiB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(1),
    caveat: 'Loopback server and clients share one process; real file-backed demo session checks use one test account. RSS includes clients. Excludes TLS, external ingest, database, maps and production network; not an SLA.' }, null, 2));
} finally {
  clearTimeout(abort);
  for (const socket of sockets) socket.terminate();
  await demo.close();
  await fs.unlink(path.join(dir, 'access.json'));
  await fs.rmdir(dir);
}
