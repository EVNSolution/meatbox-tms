import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchRoute } from '../api/driverApi';
import type { DriverRoute } from '../api/driverContracts';
import { ApiError } from '../api/types';

type Stored = { date: string; vehicleId: string; route: DriverRoute };

/**
 * The server's driver route of the chosen vehicle: ETAs, server stop IDs and the `revision` that a reorder expects.
 * It reloads whenever the date state changes. A failed read keeps the last route; only a 401 is reported.
 */
export function useDriverRoute(
  date: string,
  vehicleId: string | null,
  stateVersion: unknown,
  onSessionLost: () => void,
): { route: DriverRoute | null; reload(): Promise<DriverRoute | null> } {
  const [stored, setStored] = useState<Stored | null>(null);
  const latest = useRef(0);
  const lost = useRef(onSessionLost);
  useEffect(() => { lost.current = onSessionLost; }, [onSessionLost]);

  const read = useCallback(async (): Promise<DriverRoute | null> => {
    if (!vehicleId) return null;
    try {
      return await fetchRoute(date, vehicleId);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) lost.current();
      return null;
    }
  }, [date, vehicleId]);

  const reload = useCallback(async (): Promise<DriverRoute | null> => {
    const mine = ++latest.current;
    const route = await read();
    if (route && vehicleId && mine === latest.current) setStored({ date, vehicleId, route });
    return route;
  }, [date, read, vehicleId]);

  useEffect(() => {
    if (!stateVersion || !vehicleId) return undefined;
    const mine = ++latest.current;
    void read().then((route) => {
      if (route && mine === latest.current) setStored({ date, vehicleId, route });
    });
    return undefined;
  }, [date, read, stateVersion, vehicleId]);
  useEffect(() => () => { latest.current += 1; }, []);

  // A route of another date or vehicle is never shown.
  const route = stored && stored.date === date && stored.vehicleId === vehicleId ? stored.route : null;
  return { route, reload };
}
