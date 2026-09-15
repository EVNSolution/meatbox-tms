'use strict';

const MAX_ARRIVAL_TICKS = 10_000;

function arriveStop(sim, stopId) {
  if (typeof sim.arriveStopDirect === 'function') return sim.arriveStopDirect(stopId);
  let state = sim.snapshot();
  if (state.phase !== 'delivering' || state.truck.toId !== stopId || state.truck.dwelling) return false;

  for (let ticks = 0; ticks < MAX_ARRIVAL_TICKS; ticks++) {
    sim.tick(true);
    state = sim.snapshot();
    if (state.truck.toId === null) {
      if (!state.truck.dwelling || state.truck.fromId !== stopId) return false;
      sim.emit();
      return true;
    }
    if (state.truck.toId !== stopId) return false;
  }
  return false;
}

function completeStop(sim, stopId, confirmedRequestIds) {
  if (stopId !== undefined) {
    const { phase, truck } = sim.snapshot();
    if (phase !== 'delivering' || !truck.dwelling || truck.toId !== null || truck.fromId !== stopId) return false;
  }
  return sim.completeCurrentStop(confirmedRequestIds) !== false;
}

module.exports = { arriveStop, completeStop, MAX_ARRIVAL_TICKS };
