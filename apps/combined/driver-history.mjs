const exampleHistory = [
  {
    date: '2026-09-12',
    id: 'EXAMPLE-20260912-1',
    label: '예시 오전 배차',
    vehicle: '예시 차량 101',
    startedAt: '06:30',
    endedAt: '11:20',
    destinations: 18,
    boxes: 36,
  },
  {
    date: '2026-09-14',
    id: 'EXAMPLE-20260914-1',
    label: '예시 오전 배차',
    vehicle: '예시 차량 101',
    startedAt: '06:40',
    endedAt: '12:05',
    destinations: 21,
    boxes: 43,
  },
  {
    date: '2026-09-14',
    id: 'EXAMPLE-20260914-2',
    label: '예시 오후 지원 배차',
    vehicle: '예시 차량 203',
    startedAt: '13:10',
    endedAt: '15:00',
    destinations: 6,
    boxes: 11,
  },
];

export const exampleHistoryDates = [...new Set(exampleHistory.map(item => item.date))];

export function driverHistoryForDate(date) {
  return exampleHistory.filter(item => item.date === date).map(item => ({ ...item }));
}

export function selectedHistoryVehicle(vehicles, selectedVehicleId, routeVehicle) {
  return selectedVehicleId !== null ? vehicles.find(vehicle => vehicle.id === selectedVehicleId) || null : routeVehicle || null;
}

export async function sourceDriverHistoryForDate(date, identity, fetcher = fetch) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !identity?.driver) return [];
  const response = await fetcher(`/api/dispatch-data/days/${date}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error('source history unavailable');
  const day = await response.json();
  const groups = Array.isArray(day.groups) ? day.groups : [];
  const sameDriver = groups.filter(group => group.label === identity.driver);
  const selectedGroup = sameDriver.find(group => group.id === identity.originalGroupId);
  if (!selectedGroup && sameDriver.length > 1) throw new Error('배송원을 구분할 수 없어 이력을 표시하지 않습니다.');
  const matchingGroups = new Set((selectedGroup ? [selectedGroup] : sameDriver).map(group => group.id));
  const orders = (Array.isArray(day.orders) ? day.orders : []).filter(order => matchingGroups.has(order.groupId));
  if (!orders.length) return [];
  return [{
    date,
    id: `SOURCE-${date}-${identity.originalGroupId || identity.driver}`,
    label: `${identity.driver} 배차`,
    vehicle: identity.plate || '차량 정보 미제공',
    destinations: orders.length,
    boxes: orders.reduce((sum, order) => sum + (Number(order.boxes) || 0), 0),
    sourceRows: orders.reduce((sum, order) => sum + (Number(order.sourceRows) || 0), 0),
  }];
}
