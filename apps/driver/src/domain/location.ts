import type { AppLocation } from '../api/driverApi';

/** The `location` object of an event, or null when the reading is unusable. */
export function toAppLocation(coords: { latitude: number; longitude: number; accuracy?: number | null }): AppLocation | null {
  const { latitude, longitude, accuracy } = coords;
  const valid = Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  if (!valid) return null;
  return {
    lat: latitude,
    lng: longitude,
    ...(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyM: Math.round(accuracy) } : {}),
  };
}

/** Rejects with 'timeout' when [work] takes longer than [ms]. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
