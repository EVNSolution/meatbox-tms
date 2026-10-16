import type { DayState } from '../domain/dispatch';
import { ApiError, type DriverMessage, type SessionUser } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(): never { throw new ApiError(502, 'INVALID_RESPONSE'); }

export function readSession(value: unknown): SessionUser {
  if (!record(value) || !record(value.user) || typeof value.user.username !== 'string') return fail();
  return { username: value.user.username, displayName: typeof value.user.displayName === 'string' ? value.user.displayName : null };
}

export function readDayState(value: unknown): DayState {
  if (!record(value) || (value.boot != null && typeof value.boot !== 'string') || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0 || !Array.isArray(value.fleetVehicles) || !Array.isArray(value.fleetDeliveries)
    || !record(value.vehicleStates)) return fail();
  for (const vehicle of value.fleetVehicles) {
    if (!record(vehicle) || typeof vehicle.id !== 'string' || typeof vehicle.driver !== 'string') return fail();
  }
  for (const order of value.fleetDeliveries) {
    if (!record(order) || typeof order.id !== 'string' || typeof order.vehicleId !== 'string'
      || typeof order.name !== 'string' || typeof order.address !== 'string'
      || typeof order.boxes !== 'number' || !Number.isFinite(order.boxes)
      || typeof order.sequence !== 'number' || !Number.isFinite(order.sequence)
      || !['pending', 'current', 'done', 'skipped'].includes(String(order.status))) return fail();
    for (const field of ['arrivedAt', 'completedAt']) {
      if (order[field] != null && typeof order[field] !== 'string') return fail();
    }
  }
  for (const state of Object.values(value.vehicleStates)) {
    if (!record(state) || !['idle', 'preparing', 'delivering', 'done'].includes(String(state.phase))) return fail();
  }
  return value as unknown as DayState;
}

export function readMessages(value: unknown): DriverMessage[] {
  if (!record(value) || !Array.isArray(value.messages)) return fail();
  return value.messages.map((message) => {
    if (!record(message) || typeof message.id !== 'string' || typeof message.body !== 'string'
      || typeof message.createdAt !== 'string' || !['ops', 'driver'].includes(String(message.from))) return fail();
    return message as DriverMessage;
  });
}
