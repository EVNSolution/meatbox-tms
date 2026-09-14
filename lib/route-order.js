'use strict';

function validRouteOrder(value) {
  const permutation = ids => Array.isArray(ids) && ids.length === 8 && new Set(ids).size === 8 && ids.every(id => /^S[1-8]$/.test(id));
  return permutation(value?.order) && permutation(value?.expectedOrder)
    && Array.isArray(value.expectedStatuses) && value.expectedStatuses.length === 8
    && value.expectedStatuses.every(status => ['pending', 'current', 'done', 'skipped'].includes(status))
    && ['unordered', 'idle', 'preparing', 'delivering', 'done'].includes(value.expectedPhase);
}

function applyRouteOrder(sim, request) {
  if (!validRouteOrder(request) || sim.phase !== request.expectedPhase) return false;
  if (sim.order.some((id, index) => id !== request.expectedOrder[index] || sim.stops[id].status !== request.expectedStatuses[index])) return false;
  if (sim.order.some((id, index) => sim.stops[id].status !== 'pending' && request.order[index] !== id)) return false;
  if (sim.order.every((id, index) => id === request.order[index])) { sim.emit(); return true; }
  sim.order = [...request.order];
  sim.logEvent('운영: 배송 순서 저장 — 대기 중인 배송 순서 변경', 'driver');
  sim.recalcEtas('운영 배송 순서 변경');
  sim.emit();
  return true;
}

module.exports = { validRouteOrder, applyRouteOrder };
