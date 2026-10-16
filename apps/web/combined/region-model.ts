// Delivery zones as the operator edits them: an imported GeoJSON becomes a list of zones, which are merged with the
// current ones, renamed and removed in memory before one save. The server checks everything again; this keeps the
// operator from sending what it will refuse and says why in words.

export type Position = [number, number];
export type Geometry = { type: 'Polygon'; coordinates: Position[][] } | { type: 'MultiPolygon'; coordinates: Position[][][] };
export type Zone = { zoneId: string; label: string; geometry: Geometry };
export type Collection = { type: 'FeatureCollection'; features: { type: 'Feature'; properties: { zoneId: string; label: string }; geometry: Geometry }[] };

export const MAX_ZONES = 500;
export const MAX_VERTICES = 200_000;
const ZONE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LABEL = 100;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const toZones = (collection: unknown): Zone[] => {
  const features = record(collection) && Array.isArray(collection.features) ? collection.features : [];
  return features.flatMap((feature: unknown): Zone[] => {
    if (!record(feature) || !record(feature.properties) || !record(feature.geometry)) return [];
    const zoneId = String(feature.properties.zoneId ?? '');
    return [{ zoneId, label: String(feature.properties.label ?? zoneId), geometry: feature.geometry as unknown as Geometry }];
  });
};

export const toCollection = (zones: Zone[]): Collection => ({
  type: 'FeatureCollection',
  features: zones.map(zone => ({ type: 'Feature', properties: { zoneId: zone.zoneId, label: zone.label }, geometry: zone.geometry })),
});

export function vertexCount(geometry: Geometry): number {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0), 0);
}

const validPosition = (value: unknown): boolean => Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const validRing = (ring: unknown): boolean => Array.isArray(ring) && ring.length >= 4 && ring.every(validPosition)
  && JSON.stringify((ring as number[][])[0]!.slice(0, 2)) === JSON.stringify((ring as number[][]).at(-1)!.slice(0, 2));
const validPolygon = (polygon: unknown): boolean => Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing);

const clean = (geometry: unknown): Geometry | null => {
  if (!record(geometry)) return null;
  const strip = (ring: number[][]): Position[] => ring.map(point => [point[0]!, point[1]!]);
  if (geometry.type === 'Polygon' && validPolygon(geometry.coordinates)) return { type: 'Polygon', coordinates: (geometry.coordinates as number[][][]).map(strip) };
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length && geometry.coordinates.every(validPolygon)) {
    return { type: 'MultiPolygon', coordinates: (geometry.coordinates as number[][][][]).map(polygon => polygon.map(strip)) };
  }
  return null;
};

/** The zones in a GeoJSON text (a FeatureCollection, one Feature or one Polygon), or why it cannot be used. */
export function parseImport(text: string): { zones: Zone[]; skipped: number } | { error: string } {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return { error: 'GeoJSON 형식이 아닙니다. 파일 내용을 확인해 주세요.' }; }
  const features: unknown[] = record(root) && root.type === 'FeatureCollection' && Array.isArray(root.features) ? root.features
    : record(root) && root.type === 'Feature' ? [root]
      : record(root) && (root.type === 'Polygon' || root.type === 'MultiPolygon') ? [{ type: 'Feature', properties: {}, geometry: root }]
        : [];
  if (!features.length) return { error: 'FeatureCollection, Feature 또는 Polygon/MultiPolygon이어야 하고 비어 있으면 안 됩니다.' };
  const zones: Zone[] = [];
  let skipped = 0;
  for (const feature of features) {
    const geometry = record(feature) ? clean(feature.geometry) : null;
    if (!geometry) { skipped += 1; continue; }
    const properties = record(feature) && record(feature.properties) ? feature.properties : {};
    const source = properties.zoneId ?? properties.id ?? properties.code ?? properties.name ?? properties.label;
    const zoneId = typeof source === 'string' || typeof source === 'number' ? String(source).trim() : '';
    const named = properties.label ?? properties.name ?? zoneId;
    zones.push({ zoneId, label: String(named ?? '').trim(), geometry });
  }
  if (!zones.length) return { error: '사용할 수 있는 다각형이 없습니다. 닫힌 Polygon/MultiPolygon(경도·위도)만 가져올 수 있습니다.' };
  return { zones, skipped };
}

/**
 * Gives every zone a valid, unique code and a name. A zone without a usable code, or with a code that an earlier zone
 * of the same import already took, becomes `R1`, `R2`, … (skipping every code in [reserved]).
 */
export function normalize(zones: Zone[], reserved: Set<string>): Zone[] {
  const batch = new Set<string>();
  let counter = 0;
  return zones.map(zone => {
    let zoneId = zone.zoneId;
    if (!ZONE_ID.test(zoneId) || batch.has(zoneId)) {
      do { counter += 1; zoneId = `R${counter}`; } while (batch.has(zoneId) || reserved.has(zoneId));
    }
    batch.add(zoneId);
    return { ...zone, zoneId, label: (zone.label || zoneId).slice(0, MAX_LABEL) };
  });
}

export type Mode = 'merge' | 'replace';

/** The current zones with the imported ones: merged (a zone with the same code is replaced) or instead of all of them. */
export function importInto(current: Zone[], incoming: Zone[], mode: Mode): Zone[] {
  const base = mode === 'replace' ? [] : current;
  const claimed = new Set(base.map(zone => zone.zoneId));
  for (const zone of incoming) if (ZONE_ID.test(zone.zoneId)) claimed.add(zone.zoneId);
  const fresh = normalize(incoming, claimed);
  const ids = new Set(fresh.map(zone => zone.zoneId));
  return [...base.filter(zone => !ids.has(zone.zoneId)), ...fresh];
}

export const rename = (zones: Zone[], zoneId: string, label: string): Zone[] => zones.map(zone => (zone.zoneId === zoneId ? { ...zone, label: label.trim().slice(0, MAX_LABEL) || zone.zoneId } : zone));
export const remove = (zones: Zone[], zoneId: string): Zone[] => zones.filter(zone => zone.zoneId !== zoneId);

/** Why a list of zones cannot be saved yet, or an empty string. */
export function problem(zones: Zone[]): string {
  if (!zones.length) return '권역이 하나도 없습니다. 모두 지우려면 "준비된 권역으로 되돌리기"를 쓰세요.';
  if (zones.length > MAX_ZONES) return `권역은 ${MAX_ZONES}개까지 저장할 수 있습니다.`;
  if (zones.reduce((sum, zone) => sum + vertexCount(zone.geometry), 0) > MAX_VERTICES) return `꼭짓점은 모두 합쳐 ${MAX_VERTICES.toLocaleString('ko-KR')}개까지 저장할 수 있습니다.`;
  if (new Set(zones.map(zone => zone.zoneId)).size !== zones.length) return '권역 코드가 겹칩니다.';
  return '';
}
