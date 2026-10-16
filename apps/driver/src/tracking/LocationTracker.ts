import { ApiError } from '../api/types';
import {
  MAX_BATCH, MAX_BATCHES_PER_FLUSH, MAX_BUFFERED, RETAIN_MS, SEND_INTERVAL_MS,
} from '../domain/trackingPolicy';

// The device buffer of location samples (docs/integration-contract.md section 2): samples come in every 30 seconds,
// go out in batches about once a minute, wait on the phone while there is no network, and are dropped after an
// hour. State machine only: storage and the network come in through [TrackerPorts], so each rule is tested without
// a device. The platform layer calls [record] from the background location task.

export type Sample = { at: string; lat: number; lng: number; accuracyM?: number };

export type TrackingState = {
  date: string;
  vehicleId: string;
  samples: Sample[];
  /** Epoch ms of the last try to send; a batch is due [SEND_INTERVAL_MS] after it. */
  lastAttemptAt: number;
};

export type TrackerPorts = {
  load(): Promise<TrackingState | null>;
  save(state: TrackingState | null): Promise<void>;
  now(): number;
  send(date: string, vehicleId: string, samples: Sample[]): Promise<void>;
};

/** What a flush did: sent everything due, kept the samples (no network or not yet due), lost the session, or the day ended. */
export type FlushResult = 'idle' | 'sent' | 'kept' | 'auth' | 'ended';

type RawLocation = { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp: number };

/** A reading as a server sample, or null when it is unusable. */
export function toSample(raw: RawLocation): Sample | null {
  const { latitude, longitude, accuracy } = raw.coords;
  const usable = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180 && Number.isFinite(raw.timestamp);
  if (!usable) return null;
  return {
    at: new Date(raw.timestamp).toISOString(),
    lat: latitude,
    lng: longitude,
    ...(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyM: Math.round(accuracy) } : {}),
  };
}

export class LocationTracker {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: TrackerPorts) {}

  /** The scope being tracked, or null. */
  async current(): Promise<{ date: string; vehicleId: string } | null> {
    const state = await this.ports.load();
    return state ? { date: state.date, vehicleId: state.vehicleId } : null;
  }

  /** Starts tracking [date]/[vehicleId]; a different earlier scope is flushed and replaced. */
  start(date: string, vehicleId: string): Promise<void> {
    return this.serial(async () => {
      const state = await this.ports.load();
      if (state && state.date === date && state.vehicleId === vehicleId) return;
      if (state) await this.flushNow(state, true);
      await this.ports.save({ date, vehicleId, samples: [], lastAttemptAt: this.ports.now() });
    });
  }

  /** Adds readings and sends a batch when one is due. */
  record(readings: readonly RawLocation[]): Promise<FlushResult> {
    return this.serial(async () => {
      const state = await this.ports.load();
      if (!state) return 'idle';
      const added = readings.flatMap((reading) => { const sample = toSample(reading); return sample ? [sample] : []; });
      const merged = new Map(state.samples.map((sample) => [sample.at, sample]));
      added.forEach((sample) => merged.set(sample.at, sample));
      return this.flushNow({ ...state, samples: this.trim([...merged.values()]) }, false);
    });
  }

  /** Sends whatever is waiting now (app back in the foreground, route finished). */
  flush(): Promise<FlushResult> {
    return this.serial(async () => {
      const state = await this.ports.load();
      return state ? this.flushNow(state, true) : 'idle';
    });
  }

  /** Last flush, then forget the scope. Samples that could not be sent are dropped with it. */
  stop(): Promise<FlushResult> {
    return this.serial(async () => {
      const state = await this.ports.load();
      if (!state) return 'idle';
      const result = await this.flushNow(state, true);
      await this.ports.save(null);
      return result;
    });
  }

  waiting(): Promise<number> {
    return this.ports.load().then((state) => state?.samples.length ?? 0);
  }

  private trim(samples: Sample[]): Sample[] {
    const oldest = this.ports.now() - RETAIN_MS;
    const recent = samples.filter((sample) => Date.parse(sample.at) >= oldest)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    return recent.slice(-MAX_BUFFERED);
  }

  private async flushNow(initial: TrackingState, force: boolean): Promise<FlushResult> {
    let state = initial;
    const due = force || this.ports.now() - state.lastAttemptAt >= SEND_INTERVAL_MS;
    if (state.samples.length === 0 || !due) {
      await this.ports.save(state);
      return state.samples.length === 0 ? 'idle' : 'kept';
    }
    for (let batch = 0; batch < MAX_BATCHES_PER_FLUSH && state.samples.length > 0; batch += 1) {
      const chunk = state.samples.slice(0, MAX_BATCH);
      state = { ...state, lastAttemptAt: this.ports.now() };
      try {
        await this.ports.send(state.date, state.vehicleId, chunk);
        state = { ...state, samples: state.samples.slice(chunk.length) };
      } catch (error) {
        return this.afterFailure(state, chunk.length, error);
      }
    }
    await this.ports.save(state);
    return 'sent';
  }

  private async afterFailure(state: TrackingState, batchSize: number, error: unknown): Promise<FlushResult> {
    if (error instanceof ApiError) {
      // The day is closed or the vehicle is gone: there is nothing left to report to.
      if (error.status === 404 || (error.status === 409 && error.code === 'DRIVER_DATE_READ_ONLY')) {
        await this.ports.save(null);
        return 'ended';
      }
      if (error.status === 401) {
        await this.ports.save(state);
        return 'auth';
      }
      // A batch the server calls invalid would block every later one; drop it.
      if (error.status === 400 || error.status === 413) {
        await this.ports.save({ ...state, samples: state.samples.slice(batchSize) });
        return 'kept';
      }
    }
    await this.ports.save(state);
    return 'kept';
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
