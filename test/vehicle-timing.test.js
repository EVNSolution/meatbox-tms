'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { vehicleTiming } = require('../lib/vehicle-timing');
const { OperatingSimulation } = require('../lib/operating-simulation');
const { SERVICE_TIME_SEC } = require('../workspaces/sanghyun-scenario/src/simulation');

const MIN = 60 * 1000;
const departure = { vehicles: [{ id: 'V1', live: true, departure: { time: '06:30' } }] };

test('pre-departure estimate starts at fixed departure and adds final service to the last arrival', () => {
  const sim = new OperatingSimulation(() => {});
  const timing = sim.snapshot().kpi.vehicleTiming;
  const lastId = sim.order.at(-1);
  assert.equal(timing.vehicleId, 'V1');
  assert.equal(timing.departureMs, 6.5 * 60 * MIN);
  assert.equal(timing.completionMs, sim.stopEtas()[lastId] + SERVICE_TIME_SEC * 1000);
  assert.equal(timing.remainingSeconds, timing.durationSeconds, '출발 전 대기 시간은 잔여 시간에서 제외한다');
});

test('in-progress estimate follows the live route ETA and current simulation clock', () => {
  const sim = new OperatingSimulation(() => {});
  sim.setScenario('shipping', 'S1');
  const timing = sim.snapshot().kpi.vehicleTiming;
  const lastId = sim.order.at(-1);
  assert.equal(timing.completionMs, sim.stopEtas()[lastId] + SERVICE_TIME_SEC * 1000);
  assert.equal(timing.remainingSeconds, (timing.completionMs - sim.simTime) / 1000);
});

test('last current stop completes after its actual remaining dwell', () => {
  const sim = new OperatingSimulation(() => {});
  sim.setScenario('arrived', sim.order.at(-1));
  const timing = sim.snapshot().kpi.vehicleTiming;
  assert.equal(timing.completionMs, sim.simTime + sim.truck.dwellRemaining * 1000);
  assert.equal(timing.remainingSeconds, sim.truck.dwellRemaining);
});

test('fully completed route uses the latest actual delivery fact', () => {
  const sim = new OperatingSimulation(() => {});
  sim.setScenario('completed', sim.order.at(-1));
  const timing = sim.snapshot().kpi.vehicleTiming;
  assert.equal(timing.completed, true);
  assert.equal(timing.completionMs, Math.max(...sim.order.map(id => sim.stops[id].deliveredAt)));
  assert.equal(timing.remainingSeconds, 0);
  assert.equal(timing.estimatedStops, 0);
});

test('held assignment prevents a route completion estimate', () => {
  const sim = new OperatingSimulation(() => {});
  sim.toggleSkip('S2');
  const timing = sim.snapshot().kpi.vehicleTiming;
  assert.equal(timing.heldStops, 1);
  assert.equal(timing.completed, false);
  assert.equal(timing.completionMs, null);
  assert.equal(timing.remainingSeconds, null);
  assert.equal(timing.durationSeconds, null);
});

test('route reorder recalculates completion from the reordered live ETA', () => {
  const sim = new OperatingSimulation(() => {});
  sim.reorder('S2', 'down');
  const timing = sim.snapshot().kpi.vehicleTiming;
  assert.deepEqual(sim.order.slice(1, 3), ['S3', 'S2']);
  assert.equal(timing.completionMs, sim.stopEtas()[sim.order.at(-1)] + SERVICE_TIME_SEC * 1000);
});

test('times crossing midnight remain absolute simulation milliseconds', () => {
  const sim = new OperatingSimulation(() => {});
  sim.setScenario('shipping', 'S1');
  sim.globalFactor = 100;
  const timing = sim.snapshot().kpi.vehicleTiming;
  assert.ok(timing.completionMs > 24 * 60 * MIN);
  assert.equal(timing.durationSeconds, (timing.completionMs - timing.departureMs) / 1000);
});

test('missing and invalid facts stay unknown instead of becoming zero or an ETA-backed completion', () => {
  const base = { order: ['S1'], simTime: 7 * 60 * MIN, stops: { S1: { status: 'done', deliveredAt: null } }, stopEtas: () => ({ S1: 8 * 60 * MIN }) };
  assert.equal(vehicleTiming(base, departure).completionMs, null);
  assert.equal(vehicleTiming({ ...base, simTime: -1, stops: { S1: { status: 'current' } } }, departure).completionMs, null);
  assert.equal(vehicleTiming({ ...base, order: [], stops: {} }, departure).completionMs, null);
  assert.equal(vehicleTiming(base, { vehicles: [{ id: 'V1', live: true }] }).departureMs, null);
  assert.equal(vehicleTiming(base, { vehicles: [{ id: 'V1', live: true, departure: { time: '06:30' } }, { id: 'V2', live: true, departure: { time: '07:00' } }] }).vehicleId, null);
});
