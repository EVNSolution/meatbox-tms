import { ApiError, type DriverMessage, type SessionUser } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(): never { throw new ApiError(502, 'INVALID_RESPONSE'); }

export function readSession(value: unknown): SessionUser {
  if (!record(value) || !record(value.user) || typeof value.user.username !== 'string') return fail();
  return { username: value.user.username, displayName: typeof value.user.displayName === 'string' ? value.user.displayName : null };
}

export function readMessages(value: unknown): DriverMessage[] {
  if (!record(value) || !Array.isArray(value.messages)) return fail();
  return value.messages.map((message) => {
    if (!record(message) || typeof message.id !== 'string' || typeof message.body !== 'string'
      || typeof message.createdAt !== 'string' || !['ops', 'driver'].includes(String(message.from))) return fail();
    return message as DriverMessage;
  });
}
