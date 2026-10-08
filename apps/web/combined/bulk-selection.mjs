import { bundleDeliveries } from './delivery-bundles.mjs';

// The server moves a whole delivery unit (same name and address) in one step, so a selection always
// holds every order of each unit it touches. Units that are on the way or finished cannot be moved
// and never enter the selection.
const unitKey = delivery => delivery.assignmentUnitId ? `unit:${delivery.assignmentUnitId}` : `order:${delivery.id}`;

function unitsFor(deliveries, orderIds) {
  const byId = new Map(deliveries.map(delivery => [delivery.id, delivery]));
  const keys = new Set();
  for (const id of orderIds) {
    const delivery = byId.get(id);
    if (delivery) keys.add(unitKey(delivery));
  }
  const members = new Map();
  for (const delivery of deliveries) {
    const key = unitKey(delivery);
    if (!keys.has(key)) continue;
    members.set(key, [...(members.get(key) || []), delivery]);
  }
  return [...members.values()];
}

export function addUnits(selection, deliveries, orderIds) {
  const next = new Set(selection);
  let skippedProtected = 0;
  for (const unit of unitsFor(deliveries, orderIds)) {
    if (unit.some(delivery => delivery.assignmentProtected)) { skippedProtected += 1; continue; }
    unit.forEach(delivery => next.add(delivery.id));
  }
  return { selection: next, skippedProtected };
}

export function toggleUnits(selection, deliveries, orderIds) {
  const units = unitsFor(deliveries, orderIds);
  const movable = units.filter(unit => !unit.some(delivery => delivery.assignmentProtected));
  const allSelected = movable.length > 0 && movable.every(unit => unit.every(delivery => selection.has(delivery.id)));
  if (!allSelected) return addUnits(selection, deliveries, orderIds);
  const next = new Set(selection);
  movable.forEach(unit => unit.forEach(delivery => next.delete(delivery.id)));
  return { selection: next, skippedProtected: units.length - movable.length };
}

export function pruneSelection(selection, deliveries) {
  const movable = new Set(deliveries.filter(delivery => !delivery.assignmentProtected).map(delivery => delivery.id));
  return new Set([...selection].filter(id => movable.has(id)));
}

export function summarizeSelection(selection, deliveries) {
  const selected = deliveries.filter(delivery => selection.has(delivery.id));
  const boxes = selected.every(delivery => Number.isFinite(delivery.boxes) && delivery.boxes >= 0)
    ? selected.reduce((sum, delivery) => sum + delivery.boxes, 0) : null;
  return {
    deliveries: selected,
    orderIds: selected.map(delivery => delivery.id),
    orderCount: selected.length,
    destinationCount: bundleDeliveries(selected).length,
    boxes,
  };
}

// Orders already on the target vehicle stay where they are; the server reports only real changes.
export function transferPreview(selected, targetVehicleId) {
  const moving = selected.filter(delivery => delivery.vehicleId !== targetVehicleId);
  const boxes = moving.every(delivery => Number.isFinite(delivery.boxes) && delivery.boxes >= 0)
    ? moving.reduce((sum, delivery) => sum + delivery.boxes, 0) : null;
  return { moving, movingCount: moving.length, unchangedCount: selected.length - moving.length, boxes };
}

export function pointsInRectangle(points, first, second) {
  const left = Math.min(first.x, second.x);
  const right = Math.max(first.x, second.x);
  const top = Math.min(first.y, second.y);
  const bottom = Math.max(first.y, second.y);
  return points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom)
    .map(point => point.id);
}
