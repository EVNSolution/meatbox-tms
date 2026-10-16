import { API_BASE_URL } from '../config';
import { jsonInit, request, requestJson, toError } from './client';
import {
  readEventReply,
  readHistory,
  readPhotoReceipt,
  readTipReply,
  readRoute,
  readStopDetail,
  readSuggestion,
  readVehicleList,
  type DriverRoute,
  type EventReply,
  type HistoryItem,
  type RouteSuggestion,
  type StopDetail,
  type VehicleList,
} from './driverContracts';

// The driver endpoints of docs/api-reference.md. Errors are ApiError(status, problem+json code); callers branch on
// the code (REVISION_CONFLICT, ROUTE_LOCKED, STOP_NOT_FOUND, ...) and treat 401 as a lost session.
const UPLOAD_TIMEOUT_MS = 60_000;
const base = (date: string) => `/api/dispatch-data/days/${date}/driver`;
const vehicleQuery = (vehicleId: string) => `vehicleId=${encodeURIComponent(vehicleId)}`;

export type RouteRead = { notModified: true } | { notModified: false; route: DriverRoute; etag: string | null };

/** The vehicle's whole day. With the ETag of the last read, an unchanged day answers `notModified`. */
export async function pollRoute(date: string, vehicleId: string, etag: string | null): Promise<RouteRead> {
  const response = await request(`${base(date)}/route?${vehicleQuery(vehicleId)}`, {
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw await toError(response);
  return { notModified: false, route: readRoute(await response.json()), etag: response.headers.get('ETag') };
}

export async function fetchRoute(date: string, vehicleId: string): Promise<DriverRoute> {
  const read = await pollRoute(date, vehicleId, null);
  return read.notModified ? fetchRoute(date, vehicleId) : read.route;
}

/** Every vehicle of the day, for the vehicle choice. */
export async function fetchVehicles(date: string): Promise<VehicleList> {
  return readVehicleList(await requestJson(`${base(date)}/vehicles`));
}

export async function fetchStop(date: string, vehicleId: string, stopId: string): Promise<StopDetail> {
  return readStopDetail(await requestJson(`${base(date)}/stops/${encodeURIComponent(stopId)}?${vehicleQuery(vehicleId)}`));
}

/** A proposal only: the server changes nothing. Apply it with `route_reordered` and the proposal's `revision`. */
export async function suggestRoute(date: string, vehicleId: string, lockFirst?: string): Promise<RouteSuggestion> {
  const init = lockFirst ? jsonInit('POST', { lockFirst }) : { method: 'POST' };
  return readSuggestion(await requestJson(`${base(date)}/route/suggest?${vehicleQuery(vehicleId)}`, init));
}

export type AppLocation = { lat: number; lng: number; accuracyM?: number };

/** Everything that identifies one event. A resend must carry the same values, or the server answers 409. */
export type EventInput = {
  eventId: string;
  occurredAt: string;
  date: string;
  vehicleId: string;
  location?: AppLocation | null;
};

/** The ID and time of a new event. Keep it for a resend. */
export function newEventStamp(location: AppLocation | null = null): { eventId: string; occurredAt: string; location: AppLocation | null } {
  return { eventId: newEventId(), occurredAt: new Date().toISOString(), location };
}

export async function sendEvent(type: string, input: EventInput, payload: object): Promise<EventReply> {
  const body = {
    eventId: input.eventId,
    type,
    occurredAt: input.occurredAt,
    date: input.date,
    vehicleId: input.vehicleId,
    payload,
    ...(input.location ? { location: input.location } : {}),
  };
  return readEventReply(await requestJson(`${base(input.date)}/events`, jsonInit('POST', body)));
}

/** A stop event of the outbox (`stop_completed`, `stop_failed`, `stop_partially_completed`) with its payload as stored. */
export function sendStopEvent(type: string, input: EventInput, payload: object): Promise<EventReply> {
  return sendEvent(type, input, payload);
}

/** The stored result of an event, for when the answer to a send was lost. Null when the server never saw it. */
export async function fetchEvent(date: string, eventId: string): Promise<EventReply | null> {
  const response = await request(`${base(date)}/events/${encodeURIComponent(eventId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toError(response);
  return readEventReply(await response.json());
}

/** Uploads one compressed photo from a file URI. The multipart boundary is set by the runtime. */
export async function uploadPhoto(date: string, fileUri: string): Promise<{ photoId: string; bytes: number }> {
  const form = new FormData();
  form.append('file', { uri: fileUri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);
  const response = await request(`${base(date)}/photos`, { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS);
  if (!response.ok) throw await toError(response);
  return readPhotoReceipt(await response.json());
}

/** One batch of location samples (at most 200). The server keeps the newest 120 per vehicle. */
export async function sendLocations(
  date: string,
  vehicleId: string,
  samples: { at: string; lat: number; lng: number; accuracyM?: number }[],
): Promise<void> {
  await requestJson(`${base(date)}/locations`, jsonInit('POST', { vehicleId, samples }));
}

/** Saves the delivery tip of a stop. The same [requestId] and text can be sent again after a lost answer. */
export async function saveTip(
  date: string,
  vehicleId: string,
  stopId: string,
  requestId: string,
  body: string,
): Promise<{ duplicate: boolean; body: string }> {
  return readTipReply(await requestJson(
    `${base(date)}/stops/${encodeURIComponent(stopId)}/tip`,
    jsonInit('POST', { vehicleId, requestId, body }),
  ));
}

export async function fetchHistory(date: string, vehicleId: string): Promise<HistoryItem[]> {
  return readHistory(await requestJson(`${base(date)}/history?${vehicleQuery(vehicleId)}`));
}

/** Departure. The same input can be sent again after a lost response; the reply then has `duplicate: true`. */
export function sendDeparted(input: EventInput): Promise<EventReply> {
  return sendEvent('departed', input, {});
}

export function sendRouteReordered(input: EventInput, stopOrder: string[], expectedRevision: number): Promise<EventReply> {
  return sendEvent('route_reordered', input, { stopOrder, expectedRevision });
}

/** The photo bytes need the session cookie, so the image component gets this URL and sends the cookie itself. */
export function photoUrl(date: string, photoId: string): string {
  return `${API_BASE_URL}${base(date)}/photos/${encodeURIComponent(photoId)}`;
}

/** UUID v4 when the runtime has one. The server only needs 1-64 letters, digits, `-` or `_`. */
export function newEventId(): string {
  const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (random) return random();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
