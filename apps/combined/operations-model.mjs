export function operatorRoute(hash) {
  const [path, section] = hash.replace(/^#\//, '').split('/');
  const page = ['orders', 'deliveries', 'control'].includes(path) ? path : path === 'manage' ? 'control' : 'deliveries';
  return { page, controlTab: path === 'manage' || (page === 'control' && section === 'manage') ? 'management' : 'monitor' };
}

export function orderStage(delivery) {
  if (delivery.status === 'done') return 'done';
  if (delivery.status === 'skipped') return 'held';
  return ['shipping', 'nearby'].includes(delivery.customerStatus?.key) ? 'shipping' : 'preparing';
}

export function filterOrders(deliveries, query = '', status = 'all') {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  return deliveries.filter(delivery => delivery.ordered &&
    (status === 'all' || orderStage(delivery) === status) &&
    [delivery.name, delivery.address, ...delivery.items.map(item => item.name)].some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(needle)));
}

export function resolveDeliverySelection(data, selectedId) {
  const deliveries = data?.deliveries || [];
  return deliveries.find(delivery => delivery.id === selectedId)
    ?? deliveries.find(delivery => delivery.id === data?.customerStopId)
    ?? deliveries[0]
    ?? null;
}
