import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createStateFrames } from '../lib/state-frames.js';
import { createStateReceiver } from '../apps/combined/state-frames.mjs';
import { adaptSimulation } from '../apps/combined/simulation-adapter.mjs';
import { capacityFixture } from './capacity-fixture.cjs';

const bytes = value => Buffer.byteLength(value);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const output = [];
for (const vehicles of [130, 260]) {
  const state = capacityFixture({ vehicles });
  const frames = createStateFrames('capacity-check');
  const receiver = createStateReceiver();
  frames.publish(state);
  receiver.receive(JSON.parse(frames.latest.full));
  const fullBytes = bytes(frames.latest.full);
  const encoding = [], decoding = [], adapting = [], patches = [];
  // Exercise changing records across vehicles; do not only benchmark unchanged frames.
  for (let index = 0; index < 30; index++) {
    const stop = state.fleet.deliveries[(index * 157) % state.fleet.deliveries.length];
    stop.tip = { body: `부하 확인 ${index}`, author: '검증 배송원', updatedAt: index * 60_000 };
    let start = performance.now();
    frames.publish(state);
    encoding.push(performance.now() - start);
    const wire = frames.latest.patch || frames.latest.full;
    patches.push(bytes(wire));
    start = performance.now();
    const restored = receiver.receive(JSON.parse(wire));
    decoding.push(performance.now() - start);
    assert.deepEqual(restored, state);
    start = performance.now();
    const adapted = adaptSimulation(restored);
    adapting.push(performance.now() - start);
    assert.equal(adapted.fleetDeliveries.length, vehicles * 35);
  }
  const changedBytes = Math.max(...patches);
  assert.ok(changedBytes < fullBytes / 10, 'Single-record update must avoid fleet-wide retransmission');
  output.push({
    vehicles, stops: vehicles * 35, boxes: vehicles * 70,
    initialBytes: fullBytes, maxSingleStopUpdateBytes: changedBytes,
    reductionPercent: +(100 * (1 - changedBytes / fullBytes)).toFixed(2),
    encodeP95Ms: +percentile(encoding, .95).toFixed(2),
    decodeP95Ms: +percentile(decoding, .95).toFixed(2),
    adaptP95Ms: +percentile(adapting, .95).toFixed(2),
    illustrativeFanout: [130, 500].map(viewers => ({ viewers, updatesPerSecond: 1,
      fullMiBPerSecond: +(fullBytes * viewers / 1024 ** 2).toFixed(2),
      deltaMiBPerSecond: +(changedBytes * viewers / 1024 ** 2).toFixed(2) })),
  });
}
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, iterations: 30,
  caveat: 'Synthetic in-process measurement. Fanout is arithmetic, excludes TLS/HTTP/maps and does not certify production concurrency or throughput.', results: output }, null, 2));
