// Which delivery zone an order lies in. Prepared (CSV) days carry `zoneIds` from the preparation script. Orders that
// Meatbox pushes arrive with `zoneIds: []` and, when Meatbox sent `lat/lng`, with coordinates: the screen places them
// in the zones from those coordinates. The server's day bytes stay as received, so editing zones never changes a day.

type Ring = number[][];
type Geometry = { type?: string; coordinates?: unknown };
type Feature = { properties?: { zoneId?: unknown }; geometry?: Geometry | null };
export type Regions = { type?: string; features?: Feature[] } | null | undefined;
type Order = { coordinates?: unknown; zoneIds?: unknown };

const finitePair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number' && Number.isFinite(item));

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let from = 0, to = ring.length - 1; from < ring.length; to = from++) {
    const [x1, y1] = ring[from] as [number, number];
    const [x2, y2] = ring[to] as [number, number];
    if ((y1 > lat) !== (y2 > lat) && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function inPolygon(lng: number, lat: number, polygon: unknown): boolean {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  const [outer, ...holes] = polygon as Ring[];
  return Array.isArray(outer) && inRing(lng, lat, outer) && !holes.some(hole => Array.isArray(hole) && inRing(lng, lat, hole));
}

/** The ids of the zones that contain the point. A point on no polygon is in no zone. */
export function zonesAt(regions: Regions, lng: number, lat: number): string[] {
  const ids: string[] = [];
  for (const feature of regions?.features ?? []) {
    const id = feature.properties?.zoneId;
    const geometry = feature.geometry;
    if (typeof id !== 'string' || !id || !geometry) continue;
    const inside = geometry.type === 'Polygon' ? inPolygon(lng, lat, geometry.coordinates)
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.some(polygon => inPolygon(lng, lat, polygon));
    if (inside && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export const DERIVED = 'zonesDerived';

const done = new WeakMap<object, WeakMap<object, unknown[]>>();

/**
 * The orders with `zoneIds` filled from their coordinates where the day gave none. An order that already has zones, or
 * has no coordinates, is returned as it is; the array itself is returned when nothing was derived.
 */
export function withDerivedZones<T extends Order>(regions: Regions, orders: T[] | null | undefined): T[] | null | undefined {
  if (!regions || !Array.isArray(orders)) return orders;
  const cached = done.get(regions)?.get(orders);
  if (cached) return cached as T[];
  let changed = false;
  const result = orders.map(order => {
    const has = Array.isArray(order.zoneIds) && order.zoneIds.length > 0;
    if (has || !finitePair(order.coordinates)) return order;
    const ids = zonesAt(regions, order.coordinates[0], order.coordinates[1]);
    if (!ids.length) return order;
    changed = true;
    return { ...order, zoneIds: ids, [DERIVED]: true };
  });
  const answer = changed ? result : orders;
  if (!done.has(regions)) done.set(regions, new WeakMap());
  done.get(regions)!.set(orders, answer);
  return answer;
}

/** Words for what the zone figures rest on, for the places that show them. */
export function zoneNotes(orders: (Order & { [DERIVED]?: boolean; deliveryType?: unknown; items?: unknown })[] | null | undefined): string[] {
  const list = Array.isArray(orders) ? orders : [];
  const notes: string[] = [];
  const derived = list.filter(order => order[DERIVED]).length;
  const located = list.filter(order => finitePair(order.coordinates)).length;
  const hasMeatbox = list.some(order => typeof order.deliveryType === 'string');
  if (derived) notes.push(`권역 ${derived.toLocaleString('ko-KR')}건은 좌표로 화면에서 계산했습니다.`);
  if (hasMeatbox && list.length > located) notes.push(`좌표가 없는 주문 ${(list.length - located).toLocaleString('ko-KR')}건은 권역에 넣지 못했습니다. 미트박스가 주소 좌표(lat/lng)를 보내야 합니다.`);
  return notes;
}
