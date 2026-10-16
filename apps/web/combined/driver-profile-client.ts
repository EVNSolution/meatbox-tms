// The operator's driver master (`/api/ops/driver-profiles`): one profile per driver account, saved one driver at a time
// against the revision this client last read. A lost race is told and the newest list is read, never overwritten.

export const TEXT_FIELDS = [
  ['region', '권역'], ['skill', '숙련도'], ['phone', '연락처'], ['address', '주소'], ['contract', '계약정보'], ['vehicleType', '차종'], ['topSpec', '탑 사양'],
] as const;
export type TextField = typeof TEXT_FIELDS[number][0];
export type Capa = { stops: number | null; boxes: number | null; weightKg: number | null };
export type DriverProfile = Record<TextField, string | null> & { capa: Capa };
export type DriverRow = DriverProfile & { username: string; displayName: string; known: boolean; disabled: boolean };
export type DriverMaster = { revision: number; drivers: DriverRow[] };

export class ProfileError extends Error {
  readonly status: number;
  readonly conflict: boolean;
  /** No such route: this environment has no driver accounts (Node-owned modes). */
  readonly unavailable: boolean;
  constructor(message: string, status: number, code = '') {
    super(message);
    this.status = status;
    this.conflict = code === 'PROFILE_REVISION_CONFLICT';
    this.unavailable = status === 404 && code !== 'PROFILE_NOT_FOUND';
  }
}

const byCode: Record<string, string> = {
  PROFILE_REVISION_CONFLICT: '다른 변경이 먼저 저장됐습니다. 최신 기준정보를 다시 불러왔으니 확인한 뒤 다시 저장해 주세요.',
  DRIVER_NOT_FOUND: '이 기사 계정을 찾을 수 없습니다. 목록을 다시 불러와 주세요.',
  INVALID_INPUT: '입력값을 확인해 주세요. 글자 수 제한을 넘었거나 숫자가 올바르지 않습니다.',
  ROLE_FORBIDDEN: '운영자 계정만 기사 기준정보를 바꿀 수 있습니다.',
  ORIGIN_REQUIRED: '같은 출처에서 다시 시도해 주세요.',
  TOO_MANY_PROFILES: '등록할 수 있는 기사 기준정보 수를 넘었습니다.',
  DRIVER_PROFILES_INVALID: '기준정보 파일이 손상돼 읽을 수 없습니다. 운영 절차에 따라 복구해 주세요.',
  DRIVER_PROFILES_WRITE_FAILED: '기준정보를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};
const byStatus: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  403: '운영자 계정만 기사 기준정보를 볼 수 있습니다.',
  404: '이 환경에는 기사 기준정보 기능이 없습니다.',
  503: '기사 기준정보를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (): never => { throw new TypeError('기사 기준정보 응답을 확인할 수 없습니다.'); };
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

export function parseMaster(payload: unknown): DriverMaster {
  if (!record(payload) || typeof payload.revision !== 'number' || !Number.isInteger(payload.revision) || !Array.isArray(payload.drivers)) return bad();
  const drivers = payload.drivers.map((item: unknown): DriverRow => {
    if (!record(item) || typeof item.username !== 'string') return bad();
    const capa = record(item.capa) ? item.capa : {};
    const row = {
      username: item.username, displayName: typeof item.displayName === 'string' ? item.displayName : item.username,
      known: item.known === true, disabled: item.disabled === true,
      capa: { stops: number(capa.stops), boxes: number(capa.boxes), weightKg: number(capa.weightKg) },
    } as DriverRow;
    for (const [key] of TEXT_FIELDS) row[key] = text(item[key]);
    return row;
  });
  return { revision: payload.revision, drivers };
}

/** What a profile is worth saving: no text and no Capa means there is nothing to keep. */
export const isEmptyProfile = (profile: DriverProfile): boolean => TEXT_FIELDS.every(([key]) => !profile[key]) && Object.values(profile.capa).every(value => value === null);

export function createDriverProfileClient(fetchImpl: typeof fetch = fetch) {
  let snapshot: DriverMaster | null = null;

  async function request(path: string, method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
    const response = await fetchImpl(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    }).catch(() => { throw new ProfileError('기사 기준정보 요청을 보내지 못했습니다. 연결 상태를 확인해 주세요.', 0); });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => ({}));
      const code = record(payload) ? String(payload.code ?? payload.error ?? '') : '';
      throw new ProfileError(byCode[code] ?? byStatus[response.status] ?? '기사 기준정보 요청을 처리하지 못했습니다. 다시 시도해 주세요.', response.status, code);
    }
    return response.json().catch(() => bad());
  }

  return {
    get snapshot(): DriverMaster | null { return snapshot; },
    async load(): Promise<DriverMaster> {
      snapshot = parseMaster(await request('/api/ops/driver-profiles', 'GET'));
      return snapshot;
    },
    /** Saves [profile] for [username], or removes the driver's profile with null. */
    async save(username: string, profile: DriverProfile | null): Promise<DriverMaster> {
      if (!snapshot) throw new ProfileError('기사 기준정보를 먼저 불러와 주세요.', 0);
      try {
        await request(`/api/ops/driver-profiles/${encodeURIComponent(username)}`, 'PUT', { revision: snapshot.revision, profile });
      } catch (cause) {
        if (cause instanceof ProfileError && cause.conflict) await this.load().catch(() => undefined);
        throw cause;
      }
      return this.load();
    },
  };
}
export type DriverProfileClient = ReturnType<typeof createDriverProfileClient>;
