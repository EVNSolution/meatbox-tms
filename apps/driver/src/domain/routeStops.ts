import type { DriverRoute, RouteStop, StopOrderDetail } from '../api/driverContracts';
import { groupStops, type DeliveryStatus, type FleetDelivery, type Stop } from './dispatch';

const STATUSES: readonly string[] = ['pending', 'current', 'done', 'skipped'];

function deliveryOf(route: DriverRoute, stop: RouteStop, order: StopOrderDetail, position: number): FleetDelivery {
  return {
    id: order.orderId,
    vehicleId: route.vehicleId,
    orderNumber: order.orderNumber,
    name: order.name ?? stop.name,
    address: order.address ?? stop.address,
    detailAddress: order.detailAddress,
    boxes: order.boxes ?? 0,
    coordinates: stop.coordinates,
    sequence: stop.sequence ?? position + 1,
    status: (STATUSES.includes(order.status) ? order.status : stop.status) as DeliveryStatus,
    stopId: stop.stopId,
    items: order.items,
  };
}

/** The screens' stops, built from the server's: one stop per server `stopId`, in route order, with all its orders. */
export function routeStops(route: DriverRoute): Stop[] {
  return groupStops(route.stops.flatMap((stop, position) => stop.orders.map((order) => deliveryOf(route, stop, order, position))));
}
