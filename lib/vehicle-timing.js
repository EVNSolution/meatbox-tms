'use strict';

const { SERVICE_TIME_SEC } = require('../workspaces/sanghyun-scenario/src/simulation');

const MIN = 60 * 1000;

function clockMs(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? (hours * 60 + minutes) * MIN : null;
}

const validMs = value => Number.isFinite(value) && value >= 0;

// Derive timing only from the live simulation's existing ETA and delivery facts.
function vehicleTiming(sim, snapshot) {
  const stops = sim?.stops || {};
  const order = Array.isArray(sim?.order) ? sim.order : [];
  const liveVehicles = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles.filter(vehicle => vehicle?.live === true) : [];
  const liveVehicle = liveVehicles.length === 1 ? liveVehicles[0] : null;
  const vehicleId = typeof liveVehicle?.id === 'string' ? liveVehicle.id : null;
  const departureMs = clockMs(liveVehicle?.departure?.time);
  const heldStops = order.filter(id => stops[id]?.status === 'skipped').length;
  const estimatedStops = order.filter(id => !['done', 'skipped'].includes(stops[id]?.status)).length;
  const activeId = [...order].reverse().find(id => !['done', 'skipped'].includes(stops[id]?.status));
  const deliveredTimes = order.map(id => stops[id]?.deliveredAt);
  let completed = order.length > 0 && heldStops === 0
    && order.every(id => stops[id]?.status === 'done') && deliveredTimes.every(validMs);
  const simTime = validMs(sim?.simTime) ? sim.simTime : null;
  let completionMs = completed ? Math.max(...deliveredTimes) : null;
  if (!completed && heldStops === 0 && departureMs != null && simTime != null
      && typeof sim?.stopEtas === 'function' && activeId) {
    const etas = sim.stopEtas();
    const dwellRemaining = sim?.truck?.dwellRemaining;
    if (sim?.truck?.atStopId === activeId && validMs(dwellRemaining)) {
      completionMs = simTime + dwellRemaining * 1000;
    } else if (validMs(etas?.[activeId])) {
      completionMs = etas[activeId] + SERVICE_TIME_SEC * 1000;
    }
  }
  if (!validMs(completionMs) || departureMs == null || completionMs < departureMs) {
    completionMs = null;
    completed = false;
  }
  const durationSeconds = completionMs == null ? null : (completionMs - departureMs) / 1000;
  const remainingSeconds = completionMs == null || completed ? (completed ? 0 : null)
    : Math.max(0, (completionMs - Math.max(simTime, departureMs)) / 1000);
  return {
    source: 'simulation', vehicleId, departureMs, completionMs, remainingSeconds,
    durationSeconds, completed, heldStops, estimatedStops,
  };
}

module.exports = { vehicleTiming };
