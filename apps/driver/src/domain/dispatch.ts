export type DeliveryStatus = 'pending' | 'current' | 'done' | 'skipped';
export type VehiclePhase = 'idle' | 'preparing' | 'delivering' | 'done';

export type FleetDelivery = {
  id: string;
  vehicleId: string;
  orderNumber?: string | null;
  name: string;
  address: string;
  detailAddress?: string | null;
  boxes: number;
  coordinates?: [lng: number, lat: number] | null;
  sequence: number;
  status: DeliveryStatus;
  arrivedAt?: string | null;
  completedAt?: string | null;
  assignmentUnitId?: string | null;
  /** The server's stop this order belongs to. Orders with the same `stopId` are one stop. */
  stopId?: string;
  items?: { sku?: string; name?: string | null; qty?: number; boxes?: number; barcode?: string | null }[] | null;
};

export type Stop = {
  key: string;
  sequence: number;
  name: string;
  address: string;
  detailAddress: string;
  orders: FleetDelivery[];
  boxes: number;
  status: DeliveryStatus;
  arrived: boolean;
  coordinates: [number, number] | null;
};

// Today's operating date in Asia/Seoul (UTC+9, no DST).
export function seoulToday(now = Date.now()): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

// One destination bundle = one stop. The server names the stop (`stopId`); without it the bundle key is name+address.
export function stopKey(delivery: FleetDelivery): string {
  const normalize = (value: string) => value.normalize('NFC').trim();
  const name = normalize(delivery.name);
  const address = normalize(delivery.address);
  return JSON.stringify(name && address ? [name, address] : ['order', normalize(delivery.id)]);
}

export function groupStops(deliveries: readonly FleetDelivery[]): Stop[] {
  const stops = new Map<string, FleetDelivery[]>();
  for (const delivery of [...deliveries].sort((a, b) => a.sequence - b.sequence)) {
    const key = delivery.stopId ?? stopKey(delivery);
    stops.set(key, [...(stops.get(key) ?? []), delivery]);
  }
  return [...stops.entries()].map(([key, orders], index) => {
    const first = orders[0];
    return {
      key,
      sequence: index + 1,
      name: first.name,
      address: first.address,
      detailAddress: first.detailAddress ?? '',
      orders,
      boxes: orders.reduce((sum, order) => sum + (Number(order.boxes) || 0), 0),
      status: stopStatus(orders),
      arrived: orders.some((order) => order.status === 'current' && !!order.arrivedAt),
      coordinates: orders.find((order) => isCoordinate(order.coordinates))?.coordinates ?? null,
    };
  });
}

function stopStatus(orders: readonly FleetDelivery[]): DeliveryStatus {
  if (orders.some((order) => order.status === 'current')) return 'current';
  if (orders.some((order) => order.status === 'pending')) return 'pending';
  if (orders.every((order) => order.status === 'skipped')) return 'skipped';
  return 'done';
}

export function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === 'number' && Number.isFinite(part))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

export function stopProgress(stops: readonly Stop[]): { done: number; total: number } {
  return {
    done: stops.filter((stop) => stop.status === 'done').length,
    total: stops.length,
  };
}
