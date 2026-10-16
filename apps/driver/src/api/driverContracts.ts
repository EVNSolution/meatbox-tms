import { ApiError } from './types';

// Shapes of the driver endpoints in docs/api-reference.md. Anything else is rejected, never guessed.
export type RouteStopSummary = {
  stopId: string;
  sequence: number;
  orderIds: string[];
  name: string;
  address: string;
  boxes: number;
  status: 'pending' | 'current' | 'done' | 'skipped';
  eta: string | null;
  estimated: boolean | null;
};

export type DriverRoute = {
  date: string;
  vehicleId: string;
  revision: number;
  phase: 'idle' | 'preparing' | 'delivering' | 'done';
  stops: RouteStopSummary[];
  next: { stopId: string; eta: string | null } | null;
};

export type PreviousPhoto = { photoId: string; date: string; completedAt: string };

export type StopOrderDetail = {
  orderId: string;
  status: string;
  orderNumber: string | null;
  name: string | null;
  address: string | null;
  detailAddress: string | null;
  boxes: number | null;
  items: unknown;
  customerRequests: unknown;
  tip: unknown;
  transportConditions: unknown;
  access: unknown;
};

export type StopDetail = RouteStopSummary & {
  assignmentUnitId: string;
  orders: StopOrderDetail[];
  previousPhoto: PreviousPhoto | null;
};

export type RouteSuggestion = {
  vehicleId: string;
  revision: number;
  stopOrder: string[];
  changed: boolean;
  totalMinutes: number;
  totalKm: number;
  placed: { stopId: string; placed: 'no-coordinates'; afterStopId: string | null }[];
};

export type EventReply = {
  accepted: true;
  duplicate: boolean;
  receivedAt: string;
  next: { stopId: string; eta: string | null } | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(): never { throw new ApiError(502, 'INVALID_RESPONSE'); }
function text(value: unknown): string { return typeof value === 'string' ? value : fail(); }
function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : fail(); }
function nullableText(value: unknown): string | null { return value == null ? null : text(value); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(text) : fail(); }

const STATUSES = ['pending', 'current', 'done', 'skipped'];
const PHASES = ['idle', 'preparing', 'delivering', 'done'];

function readSummary(value: unknown): RouteStopSummary {
  if (!record(value) || !STATUSES.includes(String(value.status))) return fail();
  return {
    stopId: text(value.stopId),
    sequence: count(value.sequence),
    orderIds: strings(value.orderIds),
    name: text(value.name),
    address: text(value.address),
    boxes: count(value.boxes),
    status: value.status as RouteStopSummary['status'],
    eta: nullableText(value.eta),
    estimated: typeof value.estimated === 'boolean' ? value.estimated : null,
  };
}

function readNext(value: unknown): { stopId: string; eta: string | null } | null {
  if (value == null) return null;
  if (!record(value)) return fail();
  return { stopId: text(value.stopId), eta: nullableText(value.eta) };
}

export function readRoute(value: unknown): DriverRoute {
  if (!record(value) || !PHASES.includes(String(value.phase)) || !Array.isArray(value.stops)) return fail();
  return {
    date: text(value.date),
    vehicleId: text(value.vehicleId),
    revision: count(value.revision),
    phase: value.phase as DriverRoute['phase'],
    stops: value.stops.map(readSummary),
    next: readNext(value.next),
  };
}

export function readStopDetail(value: unknown): StopDetail {
  if (!record(value) || !Array.isArray(value.orders)) return fail();
  const previous = value.previousPhoto;
  return {
    ...readSummary(value),
    assignmentUnitId: text(value.assignmentUnitId),
    orders: value.orders.map((order) => {
      if (!record(order)) return fail();
      return {
        orderId: text(order.orderId),
        status: text(order.status),
        orderNumber: nullableText(order.orderNumber),
        name: nullableText(order.name),
        address: nullableText(order.address),
        detailAddress: nullableText(order.detailAddress),
        boxes: typeof order.boxes === 'number' ? order.boxes : null,
        items: order.items ?? null,
        customerRequests: order.customerRequests ?? null,
        tip: order.tip ?? null,
        transportConditions: order.transportConditions ?? null,
        access: order.access ?? null,
      };
    }),
    previousPhoto: previous == null ? null : readPreviousPhoto(previous),
  };
}

function readPreviousPhoto(value: unknown): PreviousPhoto {
  if (!record(value)) return fail();
  return { photoId: text(value.photoId), date: text(value.date), completedAt: text(value.completedAt) };
}

export function readSuggestion(value: unknown): RouteSuggestion {
  if (!record(value) || typeof value.changed !== 'boolean' || !Array.isArray(value.placed)) return fail();
  return {
    vehicleId: text(value.vehicleId),
    revision: count(value.revision),
    stopOrder: strings(value.stopOrder),
    changed: value.changed,
    totalMinutes: count(value.totalMinutes),
    totalKm: count(value.totalKm),
    placed: value.placed.map((entry) => {
      if (!record(entry)) return fail();
      return { stopId: text(entry.stopId), placed: 'no-coordinates', afterStopId: nullableText(entry.afterStopId) };
    }),
  };
}

export function readEventReply(value: unknown): EventReply {
  if (!record(value) || value.accepted !== true || typeof value.duplicate !== 'boolean') return fail();
  return { accepted: true, duplicate: value.duplicate, receivedAt: text(value.receivedAt), next: readNext(value.next) };
}
