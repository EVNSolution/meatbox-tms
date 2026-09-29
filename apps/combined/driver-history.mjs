import { sourceViewerPlan } from './source-viewer-plan.mjs';
import { destinationKey } from './delivery-bundles.mjs';

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

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const dateValue = value => typeof value === 'string' ? value : value?.date;

export function driverOperatingDate(sourceData, today) {
  if (validDate(sourceData?.operatingDate)) return sourceData.operatingDate;
  if (validDate(sourceData?.today)) return sourceData.today;
  return today;
}

export function driverRouteContext(sourceData, dispatch, today) {
  const date = validDate(sourceData?.date) ? sourceData.date : null;
  const operatingDate = driverOperatingDate(sourceData, today);
  return { label: date || '오늘', readOnly: Boolean(date && (date < operatingDate || dispatch?.readOnly)) };
}

export function latestPastHistoryDate(dates, operatingDate, fallback) {
  return (dates || []).map(dateValue).filter(date => validDate(date) && date < operatingDate).sort().at(-1) || fallback;
}

export async function sourceDriverHistoryForDate(date, identity, fetcher = fetch) {
  if (!validDate(date) || !identity?.driver || (validDate(identity.operatingDate) && date >= identity.operatingDate)) return [];
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
  const boxValue = order => order.boxes != null && Number.isFinite(Number(order.boxes)) ? Number(order.boxes) : null;
  const destinations = [...orders.reduce((groups, order) => {
    const key = destinationKey(order);
    const current = groups.get(key);
    if (current) {
      current.boxes = current.boxes == null || boxValue(order) == null ? null : current.boxes + boxValue(order);
      current.sourceRows += Number(order.sourceRows) || 0;
    } else groups.set(key, { ...order, boxes: boxValue(order), sourceRows: Number(order.sourceRows) || 0, status: 'pending' });
    return groups;
  }, new Map()).values()];
  const plan = sourceViewerPlan({ date, deliveries: destinations });
  return [{
    date,
    id: `SOURCE-${date}-${identity.originalGroupId || identity.driver}`,
    label: `${identity.driver} 배차`,
    vehicle: identity.plate || '차량 정보 미제공',
    destinations: destinations.length,
    boxes: orders.every(order => boxValue(order) != null) ? orders.reduce((sum, order) => sum + boxValue(order), 0) : null,
    sourceRows: orders.reduce((sum, order) => sum + (Number(order.sourceRows) || 0), 0),
    plannedStartAt: plan.timing?.completionMs == null ? null : plan.departureText,
    plannedEndAt: plan.timing?.completionMs == null ? null : plan.finishText,
  }];
}
