import * as Location from 'expo-location';

import type { AppLocation } from '../api/driverApi';
import { toAppLocation, withTimeout } from '../domain/location';

const READ_TIMEOUT_MS = 8_000;

export type DepartureLocation = { location: AppLocation | null; problem: 'denied' | 'unavailable' | null };

// One foreground reading for an event. Background collection is a later unit. A missing location never blocks the
// departure: the server falls back to its newest reported position.
export async function departureLocation(): Promise<DepartureLocation> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { location: null, problem: 'denied' };
    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      READ_TIMEOUT_MS,
    );
    const location = toAppLocation(position.coords);
    return { location, problem: location ? null : 'unavailable' };
  } catch {
    return { location: null, problem: 'unavailable' };
  }
}
