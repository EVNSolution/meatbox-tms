import { requestsConfirmed } from './customer-requests.mjs';

const phaseLabels = { unordered: '배차 대기', idle: '배차 대기', preparing: '상차 중', delivering: '배송 중', done: '배송 완료' };
const distanceText = metres => Number.isFinite(metres) ? metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m` : '이동 중';
const childOrders = stop => Array.isArray(stop?.orders) && stop.orders.length ? stop.orders : [stop].filter(Boolean);

export function driverDeliveryMatchesId(stop, id) {
  if (!stop || id == null) return false;
  return stop.id === id || stop.orderIds?.includes(id) || childOrders(stop).some(order => order.id === id);
}

export function driverOrderDetails(stop) {
  return childOrders(stop).map(order => ({
    orderNumber: order.orderNumber || order.orderNo || null,
    boxes: order.boxes != null && Number.isFinite(Number(order.boxes)) ? Number(order.boxes) : null,
    items: Array.isArray(order.items) ? order.items : [],
  }));
}

export function driverLocationPresentation(stop) {
  const name = String(stop?.name ?? '').trim();
  const address = String(stop?.address ?? '').trim();
  const generic = /^(?:\d+|\d+층|지층)$/.test(name);
  return {
    heading: generic ? address || '배송지' : name || address || '배송지',
    address: generic && address ? null : address || null,
  };
}

export function driverTipAttribution(tip) {
  if (!tip) return '작성 기록 없음';
  return `${tip.author || '배송원'}${tip.updatedAt ? ` (${tip.updatedAt})` : ''}`;
}

export function driverRouteSnapshot(deliveries = []) {
  return deliveries.flatMap(stop => childOrders(stop).map(order => ({
    id: order.id,
    status: order.status ?? stop.status,
  })));
}

export function driverHasConfirmedDispatch(state) {
  if (!state?.sourceData) return true;
  return ['published', 'amending'].includes(state.dispatch?.phase) && Boolean(state.fleetDeliveries?.length);
}

export function driverConfirmedVehicles(state) {
  if (!state?.sourceData) return state?.fleetVehicles?.length ? state.fleetVehicles : [state?.vehicle].filter(Boolean);
  const assigned = new Set((state.fleetDeliveries || []).map(stop => stop.vehicleId));
  return (state.fleetVehicles || []).filter(vehicle => assigned.has(vehicle.id));
}

export function driverCanStart(state, connected = true, vehicle = state?.vehicle) {
  const startPhases = state?.sourceData ? ['idle', 'preparing'] : ['preparing'];
  return Boolean(connected && vehicle?.live !== false && driverHasConfirmedDispatch(state)
    && startPhases.includes(state?.phase) && state?.deliveries?.some(stop => stop.status === 'pending'));
}

export function driverCanArrive(state, connected = true) {
  const current = state?.deliveries?.find(stop => stop.status === 'current');
  return Boolean(state?.sourceData && connected && driverHasConfirmedDispatch(state) && state.phase === 'delivering'
    && current && !state.truck?.dwelling && driverDeliveryMatchesId(current, state.truck?.toId));
}

export function driverViewModel(state, connected = true, selectedId = null) {
  const selected = driverTipDelivery(state, selectedId);
  const selectedVehicleId = selected?.vehicle?.id ?? selected?.vehicleId ?? null;
  const liveContext = Boolean(selected && (selected.vehicle?.live === true || (state.vehicle?.id && selectedVehicleId === state.vehicle.id)));
  const vehicle = liveContext ? (selected.vehicle || state.vehicle) : (selected?.vehicle || (selectedVehicleId ? { id: selectedVehicleId } : null));
  const deliveries = liveContext
    ? state.deliveries
    : vehicle?.id ? state.fleetDeliveries.filter(stop => (stop.vehicle?.id ?? stop.vehicleId) === vehicle.id) : [];
  const current = liveContext ? deliveries.find(stop => stop.status === 'current') ?? null : null;
  const done = deliveries.filter(stop => stop.status === 'done').length;
  const active = deliveries.filter(stop => ['current', 'pending'].includes(stop.status)).length;
  const remaining = deliveries.filter(stop => !['done', 'skipped'].includes(stop.status));
  const remainingBoxes = remaining.every(stop => Number.isFinite(stop.boxes))
    ? remaining.reduce((sum, stop) => sum + stop.boxes, 0) : null;
  const canComplete = liveContext && connected && Boolean(current && state.truck?.dwelling);
  return {
    selected, vehicle, deliveries, current,
    status: liveContext ? current && state.truck?.dwelling ? '하차 중' : phaseLabels[state.phase] || '상태 확인 중' : '조회 전용',
    statusTone: liveContext && state.phase === 'done' ? 'done' : liveContext && current ? 'active' : 'idle',
    destination: liveContext ? state.phase === 'done' ? '금일 배송 완료' : current?.name || '물류센터 출발 대기' : selected?.name || '배송지',
    address: liveContext ? state.phase === 'done' ? '모든 배송을 완료했습니다.' : current?.address || '배송 출발 전입니다.' : selected?.address || '배송지 정보 없음',
    distance: current ? state.truck?.dwelling ? '도착' : distanceText(state.truck?.remainingM) : '—',
    boxes: current?.boxes != null ? `${current.boxes}박스` : remainingBoxes == null ? '박스 수량 미확인' : `${remainingBoxes}박스`,
    progress: `${done}/${deliveries.length}`,
    todayCounts: { active, done, skipped: deliveries.filter(stop => stop.status === 'skipped').length },
    remainingBoxes,
    finishEta: liveContext ? state.kpi?.finishEta || '—' : '—',
    canComplete,
    actionNote: canComplete ? `${current.name} 하차 완료를 현재 시각에 기록합니다.` : current ? '차량 도착 후 완료할 수 있습니다.' : liveContext ? '현재 완료할 배송이 없습니다.' : '조회 전용 차량은 배송 완료 처리할 수 없습니다.',
  };
}

export function driverTipDelivery(state, selectedId) {
  const fleet = state?.fleetDeliveries?.length ? state.fleetDeliveries : state?.deliveries || [];
  return fleet.find(delivery => driverDeliveryMatchesId(delivery, selectedId))
    ?? fleet.find(delivery => driverDeliveryMatchesId(delivery, state?.customerStopId))
    ?? fleet[0]
    ?? null;
}

export function reconcileDriverRoute(previousCompleted, completed, group) {
  const changed = previousCompleted !== null && previousCompleted !== completed;
  return {
    changed,
    completed,
    group: group === null ? 'today' : group,
  };
}

export function driverMapDelivery(deliveries, selectedId) {
  return deliveries.find(stop => driverDeliveryMatchesId(stop, selectedId) && stop.status !== 'skipped')
    ?? deliveries.find(stop => stop.status === 'current')
    ?? deliveries.find(stop => stop.status === 'pending')
    ?? deliveries.find(stop => stop.status !== 'skipped')
    ?? null;
}

export function completionProofIsCurrent(state, stopId) {
  return Boolean(state?.truck?.dwelling && state?.deliveries?.some(stop => driverDeliveryMatchesId(stop, stopId) && stop.status === 'current'));
}

export function completionProofCanSubmit(state, connected, stopId, hasPhoto, confirmedRequestIds = []) {
  const stop = state?.deliveries?.find(item => driverDeliveryMatchesId(item, stopId));
  return Boolean(connected && hasPhoto && completionProofIsCurrent(state, stopId) && requestsConfirmed(stop, confirmedRequestIds));
}

export function completionProofShouldClose(state, connected, stopId) {
  return !connected || !completionProofIsCurrent(state, stopId);
}
