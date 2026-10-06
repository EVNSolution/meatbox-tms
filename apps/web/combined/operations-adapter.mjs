import { bundleDeliveries } from './delivery-bundles.mjs';
import { validOperatingDate } from './operating-date.mjs';

export function adaptOperations(snapshot) {
  if (!snapshot?.sourceData || typeof snapshot.sourceData !== 'object' || Array.isArray(snapshot.sourceData)
    || !validOperatingDate(snapshot.sourceData.date) || !Array.isArray(snapshot.fleetDeliveries)
    || !Array.isArray(snapshot.fleetVehicles) || !snapshot.vehicleStates || typeof snapshot.vehicleStates !== 'object'
    || Array.isArray(snapshot.vehicleStates)) throw new TypeError('배송 자료를 확인해 주세요.');
  const sourceOrders = snapshot.fleetDeliveries;
  const fleetDeliveries = bundleDeliveries(sourceOrders);
  const representativeId = id => fleetDeliveries.find(stop => stop.id === id || stop.orderIds.includes(id))?.id ?? null;
  const canonicalStopId = id => representativeId(id) ?? id ?? null;
  const adaptTruck = truck => truck && ({ ...truck,
    fromId: canonicalStopId(truck.fromId), toId: canonicalStopId(truck.toId), atStopId: canonicalStopId(truck.atStopId),
  });
  const selectedVehicleId = snapshot.vehicle?.id ?? snapshot.sourceData.defaultVehicleId;
  return {
    ...snapshot,
    sourceData: { ...snapshot.sourceData, defaultStopId: representativeId(snapshot.sourceData.defaultStopId) },
    sourceOrders,
    fleetDeliveries,
    deliveries: fleetDeliveries.filter(stop => stop.vehicleId === selectedVehicleId),
    vehicleStates: Object.fromEntries(Object.entries(snapshot.vehicleStates).map(([id, state]) => [id, { ...state, truck: adaptTruck(state?.truck) }])),
    truck: adaptTruck(snapshot.truck),
    customerStopId: representativeId(snapshot.customerStopId ?? snapshot.sourceData.defaultStopId),
  };
}

export const calculatedEtaText = delivery => delivery?.calculatedEta || '미확인';
