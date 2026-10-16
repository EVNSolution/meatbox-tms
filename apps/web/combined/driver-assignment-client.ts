// The operator's view of which driver account drives which vehicle (`/api/ops/driver-assignments`). Every change is one
// PUT for one vehicle, compared against the revision this client last read; a lost race is told, never overwritten.

export type DriverAccount = { username: string; displayName: string; disabled: boolean };
export type Assignment = { vehicleId: string; driver: string; known: boolean };
export type Assignments = { revision: number; assignments: Assignment[]; drivers: DriverAccount[] };

export class AssignmentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly conflict: boolean;
  /** No such route: the environment has no driver accounts at all (Node-owned modes), which is not "nobody assigned". */
  readonly unavailable: boolean;
  constructor(message: string, status: number, code = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.conflict = code === 'ASSIGNMENT_REVISION_CONFLICT';
    this.unavailable = status === 404 || status === 503;
  }
}

const byCode: Record<string, string> = {
  ASSIGNMENT_REVISION_CONFLICT: '다른 변경이 먼저 저장됐습니다. 최신 배정을 다시 불러왔으니 확인한 뒤 다시 선택해 주세요.',
  DRIVER_NOT_FOUND: '선택한 기사 계정을 찾을 수 없거나 비활성입니다. 목록을 다시 불러와 주세요.',
  TOO_MANY_ASSIGNMENTS: '배정할 수 있는 차량 수를 넘었습니다.',
  ROLE_FORBIDDEN: '운영자 계정만 기사 배정을 바꿀 수 있습니다.',
  ORIGIN_REQUIRED: '같은 출처에서 다시 시도해 주세요.',
  DRIVER_ASSIGNMENTS_INVALID: '배정 파일이 손상돼 기사 배정을 읽을 수 없습니다. 운영 절차에 따라 복구해 주세요.',
  DRIVER_ASSIGNMENTS_WRITE_FAILED: '배정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};
const byStatus: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  404: '이 환경에는 기사 배정 기능이 없습니다.',
  503: '기사 배정을 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (): never => { throw new TypeError('기사 배정 응답을 확인할 수 없습니다.'); };

export function parseAssignments(payload: unknown): Assignments {
  if (!record(payload) || typeof payload.revision !== 'number' || !Number.isInteger(payload.revision)
    || !Array.isArray(payload.assignments) || !Array.isArray(payload.drivers)) return bad();
  const assignments = payload.assignments.map((item: unknown): Assignment => {
    if (!record(item) || typeof item.vehicleId !== 'string' || typeof item.driver !== 'string') return bad();
    return { vehicleId: item.vehicleId, driver: item.driver, known: item.known === true };
  });
  const drivers = payload.drivers.map((item: unknown): DriverAccount => {
    if (!record(item) || typeof item.username !== 'string' || typeof item.displayName !== 'string') return bad();
    return { username: item.username, displayName: item.displayName, disabled: item.disabled === true };
  });
  return { revision: payload.revision, assignments, drivers };
}

export function createDriverAssignmentClient(fetchImpl: typeof fetch = fetch) {
  let snapshot: Assignments | null = null;

  async function request(path: string, method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
    const response = await fetchImpl(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    }).catch(() => { throw new AssignmentError('기사 배정 요청을 보내지 못했습니다. 연결 상태를 확인해 주세요.', 0); });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => ({}));
      const code = record(payload) ? String(payload.code ?? payload.error ?? '') : '';
      throw new AssignmentError(byCode[code] ?? byStatus[response.status] ?? '기사 배정 요청을 처리하지 못했습니다. 다시 시도해 주세요.', response.status, code);
    }
    return response.json().catch(() => bad());
  }

  return {
    get snapshot(): Assignments | null { return snapshot; },
    async load(): Promise<Assignments> {
      snapshot = parseAssignments(await request('/api/ops/driver-assignments', 'GET'));
      return snapshot;
    },
    /** Gives the vehicle to [driver], or takes it away with null. On a lost race the newest list is read before throwing. */
    async assign(vehicleId: string, driver: string | null): Promise<Assignments> {
      if (!snapshot) throw new AssignmentError('기사 배정을 먼저 불러와 주세요.', 0);
      const read = snapshot;
      try {
        const reply = await request(`/api/ops/driver-assignments/${encodeURIComponent(vehicleId)}`, 'PUT', { revision: read.revision, driver });
        if (!record(reply) || typeof reply.revision !== 'number') return bad();
        const others = read.assignments.filter(item => item.vehicleId !== vehicleId);
        const account = read.drivers.find(item => item.username === driver);
        snapshot = { ...read, revision: reply.revision, assignments: driver === null ? others : [...others, { vehicleId, driver, known: Boolean(account && !account.disabled) }] };
        return snapshot;
      } catch (cause) {
        if (cause instanceof AssignmentError && cause.conflict) await this.load().catch(() => undefined);
        throw cause;
      }
    },
  };
}
export type DriverAssignmentClient = ReturnType<typeof createDriverAssignmentClient>;
