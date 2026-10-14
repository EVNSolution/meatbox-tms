import { API_BASE_URL, API_ORIGIN } from '../config';
import type { DayState } from '../domain/dispatch';
import { readDayState, readMessages, readSession } from './contracts';
import { ApiError, type DriverMessage, type SessionUser } from './types';

// Native networking owns the HttpOnly cookie. Confirm login through /api/session
// after following the redirect. Restore checks the server; passwords are never saved.
// Cookie persistence across Android process death still requires device verification.
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', API_ORIGIN);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(`${API_BASE_URL}${path}`, { ...init, headers, credentials: 'include', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) throw await toError(response);
  return response.status === 204 ? (undefined as T) : (await response.json() as T);
}

async function toError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    const value = body.code ?? body.error;
    if (typeof value === 'string') code = value;
  } catch {
    // Non-JSON error body (for example an HTML login page).
  }
  return new ApiError(response.status, code);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const form = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    + `&next=${encodeURIComponent('/combined/')}`;
  const response = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: form,
  });
  if (response.status === 401) throw new ApiError(401, 'LOGIN_FAILED');
  if (response.status === 429) throw new ApiError(429, 'RATE_LIMITED');
  if (response.status >= 400) throw new ApiError(response.status, `HTTP_${response.status}`);
  // Success is the 303 + Set-Cookie; confirm it took effect.
  const user = await getSession();
  if (user === null) throw new ApiError(401, 'LOGIN_FAILED');
  return user;
}

export async function getSession(): Promise<SessionUser | null> {
  const response = await request('/api/session');
  if (response.status === 401) return null;
  if (!response.ok) throw await toError(response);
  return readSession(await response.json());
}

export async function logout(): Promise<void> {
  const response = await request('/logout', { method: 'POST', headers: { Accept: 'text/html' } });
  if (!response.ok) throw await toError(response);
}

export type StateResult =
  | { notModified: true }
  | { notModified: false; state: DayState; etag: string | null };

export async function fetchDayState(date: string, etag: string | null): Promise<StateResult> {
  const response = await request(`/api/dispatch-data/days/${date}/state`, {
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw await toError(response);
  return {
    notModified: false,
    state: readDayState(await response.json()),
    etag: response.headers.get('ETag'),
  };
}

export type DriverCommand =
  | { type: 'set_route_order'; vehicleId: string; order: string[]; expectedOrder: string[]; expectedStatuses: string[]; expectedPhase: string }
  | { type: 'start_route'; vehicleId: string }
  | { type: 'arrive_stop'; vehicleId: string; orderId: string }
  | { type: 'complete_stop'; vehicleId: string; orderId: string };

export async function sendCommand(
  date: string,
  base: Pick<DayState, 'boot' | 'revision'>,
  command: DriverCommand,
): Promise<DayState | null> {
  const body = { ...command, expectedBoot: base.boot, expectedRevision: base.revision };
  const result = await requestJson<{ state?: DayState }>(
    `/api/dispatch-data/days/${date}/commands`,
    jsonInit('POST', body),
  );
  return result?.state ? readDayState(result.state) : null;
}

export async function registerPushToken(body: {
  date: string;
  vehicleId: string;
  token: string;
  deviceId: string | null;
  platform: 'android';
}): Promise<void> {
  const { date, ...registration } = body;
  await requestJson(`/api/dispatch-data/days/${date}/driver/push-token`, jsonInit('PUT', registration));
}

export async function revokePushToken(date: string, token: string): Promise<void> {
  await requestJson(`/api/dispatch-data/days/${date}/driver/push-token`, jsonInit('DELETE', { token }));
}

export async function fetchMessages(date: string, vehicleId: string): Promise<DriverMessage[]> {
  return readMessages(await requestJson(`/api/dispatch-data/days/${date}/driver/messages?vehicleId=${encodeURIComponent(vehicleId)}`));
}

export async function sendMessage(date: string, vehicleId: string, body: string): Promise<void> {
  await requestJson(`/api/dispatch-data/days/${date}/driver/messages`, jsonInit('POST', { vehicleId, body, from: 'driver' }));
}
