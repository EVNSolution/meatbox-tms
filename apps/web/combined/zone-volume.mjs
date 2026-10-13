import { destinationKey } from './delivery-bundles.mjs';

// Volume per delivery zone: destinations (같은 이름·주소 묶음 = 착지), boxes, orders and weight.
// An order that belongs to several zones counts in each of them; the totals count every order once.
// Weight comes only from a numeric `weightKg` on the order. Without it the sum stays null (미수신),
// because the supplied source files carry no weight and nothing may be invented.
const known = value => Number.isFinite(value) && value >= 0;
export const destinationOf = delivery => delivery.assignmentUnitId ? `unit:${delivery.assignmentUnitId}` : destinationKey(delivery);
export const zoneIdsOf = delivery => [...new Set((Array.isArray(delivery?.zoneIds) ? delivery.zoneIds : []).filter(id => typeof id === 'string' && id))];

function accumulator() {
  return { orders: 0, destinations: new Set(), boxes: 0, boxesKnown: true, weight: 0, weightKnown: true };
}

function add(target, delivery) {
  target.orders += 1;
  target.destinations.add(destinationOf(delivery));
  if (known(delivery.boxes)) target.boxes += delivery.boxes; else target.boxesKnown = false;
  if (known(delivery.weightKg)) target.weight += delivery.weightKg; else target.weightKnown = false;
}

const finish = target => ({
  orders: target.orders,
  destinations: target.destinations.size,
  boxes: target.boxesKnown ? target.boxes : null,
  weightKg: target.weightKnown && target.orders ? target.weight : null,
});

export function zoneVolumes(regions, deliveries) {
  const labels = new Map((regions?.features || []).map(feature => [feature.properties?.zoneId, feature.properties?.label || feature.properties?.zoneId]));
  const zones = new Map();
  const all = accumulator();
  const unlocated = accumulator();
  for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
    add(all, delivery);
    const ids = zoneIdsOf(delivery).filter(id => labels.has(id));
    if (!ids.length) add(unlocated, delivery);
    for (const id of ids) {
      if (!zones.has(id)) zones.set(id, accumulator());
      add(zones.get(id), delivery);
    }
  }
  const rows = [...zones].map(([zoneId, value]) => ({ zoneId, label: labels.get(zoneId), ...finish(value) }))
    .sort((left, right) => (right.boxes ?? -1) - (left.boxes ?? -1) || right.orders - left.orders || String(left.label).localeCompare(String(right.label), 'ko-KR'));
  return { rows, totals: finish(all), unlocated: finish(unlocated) };
}

export const weightText = weightKg => known(weightKg) ? `${weightKg.toLocaleString('ko-KR')}kg` : '미수신';

export function volumeLabel(row) {
  const boxes = known(row.boxes) ? `${row.boxes.toLocaleString('ko-KR')}박스` : '박스 미확인';
  return `${row.destinations.toLocaleString('ko-KR')}곳 · ${boxes}${known(row.weightKg) ? ` · ${weightText(row.weightKg)}` : ''}`;
}

export function withZoneVolumes(regions, rows) {
  if (regions?.type !== 'FeatureCollection' || !Array.isArray(regions.features)) return regions;
  const byZone = new Map(rows.map(row => [row.zoneId, row]));
  return { ...regions, features: regions.features.map(feature => {
    const row = byZone.get(feature.properties?.zoneId);
    return row ? { ...feature, properties: { ...feature.properties, destinationCount: row.destinations, boxes: row.boxes, weightKg: row.weightKg, volumeLabel: volumeLabel(row) } } : feature;
  }) };
}

export function geometryBounds(feature) {
  const positions = [];
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && value.every(item => typeof item === 'number')) { positions.push(value); return; }
    value.forEach(walk);
  };
  walk(feature?.geometry?.coordinates);
  const valid = positions.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (!valid.length) return null;
  const lngs = valid.map(point => point[0]);
  const lats = valid.map(point => point[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}
