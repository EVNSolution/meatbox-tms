import { agoText } from './temperature-model.ts';

// Where each vehicle is, as the day state reports it. The server overlays the newest driver-app sample on
// `fleetVehicles[].location` (`source: "driver"`, with its time `at`); without one the location is the vehicle's
// reference place, which is not a GPS fix and is said so.

/** A driver position older than this is still drawn, but called old. */
export const OLD_AFTER_SECONDS = 600;

export type Place = { coordinates?: unknown; source?: unknown; at?: unknown; accuracyM?: unknown; label?: unknown };
export type FleetVehicle = { id: string; driver?: string; plate?: string; location?: Place | null };
export type FleetPosition = {
  vehicleId: string; coordinates: [number, number]; source: 'driver' | 'reference';
  at: string | null; ageSeconds: number | null; old: boolean; accuracyM: number | null;
};

const inRange = (lng: number, lat: number): boolean => Math.abs(lng) <= 180 && Math.abs(lat) <= 90;

export function positionOf(vehicle: FleetVehicle, now: number): FleetPosition | null {
  const place = vehicle.location;
  const c = place?.coordinates;
  if (!Array.isArray(c) || c.length !== 2 || !c.every(value => typeof value === 'number' && Number.isFinite(value)) || !inRange(c[0] as number, c[1] as number)) return null;
  const source = place?.source === 'driver' ? 'driver' : 'reference';
  const at = source === 'driver' && typeof place?.at === 'string' && Number.isFinite(Date.parse(place.at)) ? place.at : null;
  const ageSeconds = at === null ? null : Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return {
    vehicleId: vehicle.id, coordinates: [c[0] as number, c[1] as number], source, at, ageSeconds,
    old: source === 'driver' && (ageSeconds === null || ageSeconds > OLD_AFTER_SECONDS),
    accuracyM: typeof place?.accuracyM === 'number' && Number.isFinite(place.accuracyM) ? place.accuracyM : null,
  };
}

/** Every vehicle with a place, and the ones without. */
export function fleetPositions(vehicles: FleetVehicle[], now: number): { positions: FleetPosition[]; missing: FleetVehicle[] } {
  const positions: FleetPosition[] = [];
  const missing: FleetVehicle[] = [];
  for (const vehicle of vehicles) {
    const position = positionOf(vehicle, now);
    if (position) positions.push(position); else missing.push(vehicle);
  }
  return { positions, missing };
}

export function positionText(position: FleetPosition): string {
  if (position.source === 'reference') return '기준 위치 (기사 앱 위치 미수신)';
  const age = position.ageSeconds === null ? '수신 시각 미확인' : agoText(position.ageSeconds);
  return `기사 앱 위치 · ${age}${position.old ? ', 오래된 위치' : ''}`;
}

export function fleetCounts(positions: FleetPosition[], missing: FleetVehicle[]): string {
  const fresh = positions.filter(item => item.source === 'driver' && !item.old).length;
  const old = positions.filter(item => item.source === 'driver' && item.old).length;
  const reference = positions.filter(item => item.source === 'reference').length;
  return `기사 앱 위치 ${fresh}대, 오래된 위치 ${old}대, 기준 위치 ${reference}대, 위치 없음 ${missing.length}대.`;
}
