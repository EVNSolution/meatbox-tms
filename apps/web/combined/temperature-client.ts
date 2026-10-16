import { validOperatingDate } from './operating-date.mjs';
import { parseLatest, type LatestRow } from './temperature-model.ts';

// Reads of /api/telemetry/temperature. The state of the day carries the current value; these two calls add the
// per-sensor latest values (with their allowed range) and, for one vehicle, the readings of a day.

export class TemperatureError extends Error {
  readonly status: number;
  readonly unavailable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    // No telemetry module in this environment (the Node-owned modes have no such route) is not "no data".
    this.unavailable = status === 404 || status === 503;
  }
}

const messages: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  403: '온도 자료를 볼 권한이 없습니다.',
  404: '온도 수신이 설정되지 않은 환경입니다. 온도를 확인할 수 없습니다.',
  503: '온도 서비스를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
};

export type Measurement = { sensorId: string; measuredAt: string; celsius: number; min: number | null; max: number | null; count: number | null };
export type TemperatureHistory = { vehicleId: string; from: string; to: string; measurements: Measurement[]; truncated: boolean };

const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The Seoul day of [date], as the 24-hour window the server allows. Today ends now, so a part of a day is never asked for. */
export function dayWindow(date: string, now: number = Date.now()): { from: string; to: string } {
  if (!validOperatingDate(date)) throw new TypeError('조회 날짜를 확인해 주세요.');
  const from = `${date}T00:00:00+09:00`;
  const end = `${nextDay(date)}T00:00:00+09:00`;
  const start = Date.parse(from);
  return { from, to: now >= start && now < Date.parse(end) ? new Date(now).toISOString() : end };
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parseHistory(payload: unknown): TemperatureHistory {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('온도 응답을 확인할 수 없습니다.');
  const body = payload as Record<string, unknown>;
  if (typeof body.vehicleId !== 'string' || typeof body.from !== 'string' || typeof body.to !== 'string' || !Array.isArray(body.measurements)) {
    throw new TypeError('온도 응답을 확인할 수 없습니다.');
  }
  const measurements = body.measurements.map((item: unknown): Measurement => {
    const row = item as Record<string, unknown>;
    const celsius = finite(row?.celsius);
    if (typeof row?.sensorId !== 'string' || typeof row.measuredAt !== 'string' || celsius === null || !Number.isFinite(Date.parse(row.measuredAt))) {
      throw new TypeError('온도 응답을 확인할 수 없습니다.');
    }
    return { sensorId: row.sensorId, measuredAt: row.measuredAt, celsius, min: finite(row.min), max: finite(row.max), count: finite(row.count) };
  });
  return { vehicleId: body.vehicleId, from: body.from, to: body.to, measurements, truncated: body.truncated === true };
}

export function createTemperatureClient(fetchImpl: typeof fetch = fetch) {
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(path, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    }).catch(() => { throw new TemperatureError('온도를 불러오지 못했습니다. 연결 상태를 확인해 주세요.', 0); });
    if (!response.ok) throw new TemperatureError(messages[response.status] ?? '온도를 불러오지 못했습니다. 다시 시도해 주세요.', response.status);
    return response.json().catch(() => { throw new TypeError('온도 응답을 확인할 수 없습니다.'); });
  }
  return {
    async latest(signal?: AbortSignal): Promise<LatestRow[]> {
      return parseLatest(await get('/api/telemetry/temperature/latest', signal));
    },
    async history(vehicleId: string, date: string, signal?: AbortSignal, now?: number): Promise<TemperatureHistory> {
      if (!vehicleId) throw new TypeError('차량을 확인해 주세요.');
      const { from, to } = dayWindow(date, now);
      const query = new URLSearchParams({ from, to, resolution: '1m' });
      return parseHistory(await get(`/api/telemetry/temperature/${encodeURIComponent(vehicleId)}?${query}`, signal));
    },
  };
}
export type TemperatureClient = ReturnType<typeof createTemperatureClient>;
