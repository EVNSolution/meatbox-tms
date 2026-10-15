export const subtabs = {
  orders: [['plan', '배차'], ['zones', '권역 물량'], ['list', '주문 목록']],
  control: [['map', '관제'], ['stops', '배송지'], ['records', '기록']],
};

export function operatorRoute(hash = '') {
  const [path, section] = hash.replace(/^#\//, '').split('/');
  const page = ['orders', 'deliveries', 'control'].includes(path) ? path : path === 'manage' ? 'control' : 'orders';
  const manage = path === 'manage' || (page === 'control' && section === 'manage');
  const known = (subtabs[page] || []).map(([id]) => id);
  const subtab = manage ? 'records' : known.includes(section) ? section : known[0] || '';
  return { page, subtab, controlTab: subtab === 'records' ? 'management' : 'monitor' };
}

export function routeHash(page, subtab) {
  const first = (subtabs[page] || [])[0]?.[0];
  return subtab && subtab !== first ? `#/${page}/${subtab}` : `#/${page}`;
}

export function controlDataPresentation(context, message = '배송 자료를 확인하고 있습니다.') {
  if (context?.invalid) return { empty: false, message: '요청한 날짜가 올바르지 않습니다. 조회 날짜를 다시 선택해 주세요.' };
  if (context?.empty) return { empty: true, message: `${context.date || '선택한 날짜'}에 배송 자료가 없습니다. 배차가 확정되면 관제에 표시됩니다.` };
  return { empty: false, message: message || '배송 자료를 확인하고 있습니다.' };
}

export function filterFleetDeliveries(deliveries, { query = '', status = 'all', vehicleId = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  return deliveries.filter(delivery =>
    (status === 'all' || delivery.status === status) &&
    (vehicleId === 'all' || delivery.vehicleId === vehicleId) &&
    [delivery.id, delivery.name, delivery.address, delivery.vehicle?.plate, delivery.vehicle?.driver]
      .some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(needle)));
}

export function normalizeVehicleFilter(vehicleId, vehicles = []) {
  return vehicleId === 'all' || vehicles?.some(vehicle => vehicle.id === vehicleId) ? vehicleId : 'all';
}

export function resolveDeliverySelection(data, selectedId) {
  const deliveries = data?.fleetDeliveries || data?.deliveries || [];
  return deliveries.find(delivery => delivery.id === selectedId)
    ?? deliveries.find(delivery => delivery.id === data?.customerStopId)
    ?? deliveries[0]
    ?? null;
}
