import { destinationOf, zoneIdsOf } from './zone-volume.mjs';

// "타 권역 이관" moves a delivery bundle to a driver who already serves another zone. The bundle keeps
// its place on the map and its zone membership; only the driver changes. A zone's drivers are derived
// from the current assignment (who holds orders inside it), because no stored zone-to-driver mapping exists.
const known = value => Number.isFinite(value) && value >= 0;

export function zoneDrivers(deliveries) {
  const zones = new Map();
  for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
    if (!delivery?.vehicleId) continue;
    for (const zoneId of zoneIdsOf(delivery)) {
      if (!zones.has(zoneId)) zones.set(zoneId, new Map());
      const drivers = zones.get(zoneId);
      if (!drivers.has(delivery.vehicleId)) drivers.set(delivery.vehicleId, { vehicleId: delivery.vehicleId, orders: 0, destinations: new Set(), boxes: 0, boxesKnown: true });
      const load = drivers.get(delivery.vehicleId);
      load.orders += 1;
      load.destinations.add(destinationOf(delivery));
      if (known(delivery.boxes)) load.boxes += delivery.boxes; else load.boxesKnown = false;
    }
  }
  return new Map([...zones].map(([zoneId, drivers]) => [zoneId, [...drivers.values()].map(load => ({
    vehicleId: load.vehicleId, orders: load.orders, destinations: load.destinations.size, boxes: load.boxesKnown ? load.boxes : null,
  })).sort((left, right) => (right.boxes ?? -1) - (left.boxes ?? -1) || right.orders - left.orders || String(left.vehicleId).localeCompare(String(right.vehicleId)))]));
}

// Zones other than the bundle's own that have at least one other candidate driver to hand it to.
export function transferZoneOptions(rows, drivers, candidateVehicleIds, { fromZoneId, fromVehicleId } = {}) {
  const candidates = new Set(candidateVehicleIds);
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    if (row.zoneId === fromZoneId) return [];
    const loads = (drivers.get(row.zoneId) || []).filter(load => load.vehicleId !== fromVehicleId && candidates.has(load.vehicleId));
    return loads.length ? [{ zoneId: row.zoneId, label: row.label, loads }] : [];
  });
}

export function driverNamesText(loads, nameOf, limit = 2) {
  if (!loads?.length) return '배차 전';
  const names = loads.map(load => nameOf(load.vehicleId));
  return names.length > limit ? `${names.slice(0, limit).join(', ')} 외 ${names.length - limit}명` : names.join(', ');
}
