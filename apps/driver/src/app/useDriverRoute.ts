import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { pollRoute } from '../api/driverApi';
import type { DriverRoute } from '../api/driverContracts';
import { ApiError } from '../api/types';
import { POLL_INTERVAL_MS } from '../config';

type Stored = { date: string; vehicleId: string; route: DriverRoute };
type Outcome = { kind: 'route'; route: DriverRoute; etag: string | null } | { kind: 'same' } | { kind: 'error'; cause: unknown };

/**
 * The vehicle's whole day from the server: stops, orders, positions, ETAs and the `revision` that a reorder expects.
 * It reads on start, every [POLL_INTERVAL_MS] while the app is in the foreground and when the app returns to it, and
 * sends the last ETag so an unchanged day costs nothing. A failed read keeps the last route and is reported in
 * [failure]; a 401 is reported through [onSessionLost].
 */
export function useDriverRoute(
  date: string,
  vehicleId: string | null,
  onSessionLost: () => void,
): { route: DriverRoute | null; failure: unknown; reload(): Promise<DriverRoute | null> } {
  const [stored, setStored] = useState<Stored | null>(null);
  const [failed, setFailed] = useState<{ vehicleId: string; cause: unknown } | null>(null);
  const etag = useRef<string | null>(null);
  const latest = useRef(0);
  const current = useRef<DriverRoute | null>(null);
  const lost = useRef(onSessionLost);
  useEffect(() => { lost.current = onSessionLost; }, [onSessionLost]);

  const readOnce = useCallback(async (force: boolean): Promise<Outcome> => {
    if (!vehicleId) return { kind: 'same' };
    try {
      const read = await pollRoute(date, vehicleId, force ? null : etag.current);
      return read.notModified ? { kind: 'same' } : { kind: 'route', route: read.route, etag: read.etag };
    } catch (cause) {
      return { kind: 'error', cause };
    }
  }, [date, vehicleId]);

  const apply = useCallback((outcome: Outcome, mine: number): DriverRoute | null => {
    if (mine !== latest.current || !vehicleId) return null;
    if (outcome.kind === 'error') {
      if (outcome.cause instanceof ApiError && outcome.cause.status === 401) lost.current();
      setFailed({ vehicleId, cause: outcome.cause });
      return null;
    }
    setFailed(null);
    if (outcome.kind === 'route') {
      etag.current = outcome.etag;
      current.current = outcome.route;
      setStored({ date, vehicleId, route: outcome.route });
    }
    return current.current;
  }, [date, vehicleId]);

  const reload = useCallback(async (): Promise<DriverRoute | null> => {
    const mine = ++latest.current;
    return apply(await readOnce(true), mine);
  }, [apply, readOnce]);

  useEffect(() => {
    if (!vehicleId) return undefined;
    etag.current = null;
    current.current = null;
    const tick = (force: boolean) => {
      const mine = ++latest.current;
      void readOnce(force).then((outcome) => apply(outcome, mine));
    };
    tick(true);
    const timer = setInterval(() => { if (AppState.currentState === 'active') tick(false); }, POLL_INTERVAL_MS);
    const foreground = AppState.addEventListener('change', (state) => { if (state === 'active') tick(true); });
    return () => { latest.current += 1; clearInterval(timer); foreground.remove(); };
  }, [apply, readOnce, vehicleId]);

  // A route of another date or vehicle is never shown.
  const route = stored && stored.date === date && stored.vehicleId === vehicleId ? stored.route : null;
  // A failure of the previous vehicle is not the new vehicle's.
  const failure = failed && failed.vehicleId === vehicleId ? failed.cause : null;
  return { route, failure, reload };
}
