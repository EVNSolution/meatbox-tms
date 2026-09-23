export class ApiResponseError extends Error {
  constructor(status, code) {
    super(code || `요청 실패 (${status})`);
    this.name = 'ApiResponseError';
    this.status = status;
    this.code = code || 'request_failed';
  }
}

export class StaleSessionError extends Error {
  constructor() { super('stale_session'); this.name = 'StaleSessionError'; }
}

export function isTerminalSessionError(error) {
  return error instanceof ApiResponseError && ['session_required', 'session_expired'].includes(error.code);
}

export function createSessionGate() {
  let generation = 0;
  let active = false;
  return {
    begin() { active = true; generation += 1; return generation; },
    close() { active = false; generation += 1; return generation; },
    assert(expected) { if (!active || expected !== generation) throw new StaleSessionError(); },
    get active() { return active; },
    get generation() { return generation; },
  };
}

export function clearSessionData(state) {
  return Object.assign(state, {
    csrfToken:'', deliveryIds:[], deliveryId:'', delivery:null, subscription:null,
    providerReady:false, notificationPhase:'', fidVersion:null, latestFidSync:null, fidSyncError:null,
    pollingTimer:null,
  });
}
