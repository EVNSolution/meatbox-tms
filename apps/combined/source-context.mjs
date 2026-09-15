import { sourceViewerPlan } from './source-viewer-plan.mjs';

// Source state contains every vehicle; each viewer operates on its selected route.
export function sourceVehicleContext(data, selectedId) {
  if (!data?.sourceData || data.customerDemo) return data;
  const selected = data.fleetDeliveries.find(stop => stop.id === selectedId)
    ?? data.fleetDeliveries.find(stop => stop.id === data.sourceData.defaultStopId)
    ?? data.fleetDeliveries[0];
  const vehicle = data.fleetVehicles.find(item => item.id === selected?.vehicleId)
    ?? data.fleetVehicles.find(item => item.id === data.sourceData.defaultVehicleId);
  const context = data.vehicleStates?.[vehicle?.id] ?? {};
  const plan = sourceViewerPlan({ date: data.sourceData.date,
    deliveries: data.fleetDeliveries.filter(stop => stop.vehicleId === vehicle?.id),
    events: data.events, vehicleId: vehicle?.id });
  const deliveries = plan.deliveries;
  const planned = new Map(deliveries.map(stop => [stop.id, stop]));
  return { ...data, ...context, vehicle, deliveries,
    fleetDeliveries: data.fleetDeliveries.map(stop => planned.get(stop.id) || stop),
    viewerPlan: { departureText: plan.departureText, finishText: plan.finishText, timing: plan.timing },
    customerStopId: selected?.id ?? null,
    kpi: { ...context.kpi, finishEta: context.kpi?.finishEta || plan.finishText,
      stops: deliveries.length, completed: deliveries.filter(stop => stop.status === 'done').length },
  };
}

export function sourceRouteData(deliveries = []) {
  return { points: deliveries.filter(stop => Array.isArray(stop.coordinates) && stop.coordinates.length === 2 && stop.coordinates.every(Number.isFinite))
    .map(stop => ({ id: stop.id, name: stop.name, lng: stop.coordinates[0], lat: stop.coordinates[1] })), routes: [] };
}
