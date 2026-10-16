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

// An order's weight is its own `weightKg` or the sum of its items' `weightKg` (each item's figure is the line's total, per
// Meatbox's contract). One item without a weight makes the order's weight unknown.
export function orderWeightKg(order) {
  if (known(order?.weightKg)) return order.weightKg;
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length || !items.every(item => known(item?.weightKg))) return null;
  return Math.round(items.reduce((sum, item) => sum + item.weightKg, 0) * 1000) / 1000;
}

function add(target, delivery) {
  target.orders += 1;
  target.destinations.add(destinationOf(delivery));
  if (known(delivery.boxes)) target.boxes += delivery.boxes; else target.boxesKnown = false;
  const weight = orderWeightKg(delivery);
  if (known(weight)) target.weight += weight; else target.weightKnown = false;
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

/** Why a weight is missing, for the places that show one. */
export function weightNote(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  if (!list.length) return '';
  const withWeight = list.filter(order => known(orderWeightKg(order))).length;
  if (withWeight === list.length) return '';
  const meatbox = list.some(order => typeof order.deliveryType === 'string');
  if (!withWeight) return meatbox ? '중량은 미트박스 주문의 품목 중량(items[].weightKg)에서 계산합니다. 이 날짜 주문에는 품목 중량이 없습니다.' : '이 날짜의 CSV 원본에는 중량이 없어 중량은 미수신입니다. 중량은 미트박스 주문에서만 들어옵니다.';
  return `품목 중량이 없는 주문 ${(list.length - withWeight).toLocaleString('ko-KR')}건이 있어 그 주문이 속한 권역의 중량 합계는 미수신입니다.`;
}

export const weightText = weightKg => known(weightKg) ? `${weightKg.toLocaleString('ko-KR')}kg` : '미수신';

// Lines of the zone hover popover: one figure per line, no separator dots.
export function volumeLines(row) {
  const lines = [`${row.destinations.toLocaleString('ko-KR')} Stop`, known(row.boxes) ? `${row.boxes.toLocaleString('ko-KR')} box` : 'box 미확인'];
  if (known(row.weightKg)) lines.push(weightText(row.weightKg));
  return lines;
}

export function withZoneVolumes(regions, rows) {
  if (regions?.type !== 'FeatureCollection' || !Array.isArray(regions.features)) return regions;
  const byZone = new Map(rows.map(row => [row.zoneId, row]));
  return { ...regions, features: regions.features.map(feature => {
    const row = byZone.get(feature.properties?.zoneId);
    return row ? { ...feature, properties: { ...feature.properties, destinationCount: row.destinations, boxes: row.boxes, weightKg: row.weightKg } } : feature;
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
