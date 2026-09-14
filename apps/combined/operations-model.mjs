export function operatorRoute(hash) {
  const [path, section] = hash.replace(/^#\//, '').split('/');
  const page = ['orders', 'deliveries', 'control'].includes(path) ? path : path === 'manage' ? 'control' : 'deliveries';
  return { page, controlTab: path === 'manage' || (page === 'control' && section === 'manage') ? 'management' : 'monitor' };
}

export function filterFleetDeliveries(deliveries, { query = '', status = 'all', vehicleId = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  return deliveries.filter(delivery =>
    (status === 'all' || delivery.status === status) &&
    (vehicleId === 'all' || delivery.vehicleId === vehicleId) &&
    [delivery.id, delivery.name, delivery.address, delivery.vehicle?.plate, delivery.vehicle?.driver]
      .some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(needle)));
}

export function resolveDeliverySelection(data, selectedId) {
  const deliveries = data?.fleetDeliveries || data?.deliveries || [];
  return deliveries.find(delivery => delivery.id === selectedId)
    ?? deliveries.find(delivery => delivery.id === data?.customerStopId)
    ?? deliveries[0]
    ?? null;
}
