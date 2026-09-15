const phaseLabels = { unordered: '배차 대기', idle: '배차 대기', preparing: '상차 중', delivering: '배송 중', done: '배송 완료' };
const distanceText = metres => Number.isFinite(metres) ? metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m` : '이동 중';

export function driverViewModel(state, connected = true, selectedId = null) {
  const selected = driverTipDelivery(state, selectedId);
  const liveContext = !selected?.vehicle || selected.vehicle.live === true || selected.vehicle.id === state.vehicle?.id;
  const vehicle = liveContext ? (selected?.vehicle || state.vehicle) : selected.vehicle;
  const deliveries = liveContext
    ? state.deliveries
    : state.fleetDeliveries.filter(stop => stop.vehicle?.id === vehicle.id);
  const current = liveContext ? deliveries.find(stop => stop.status === 'current') ?? null : null;
  const done = deliveries.filter(stop => stop.status === 'done').length;
  const remainingBoxes = deliveries.filter(stop => !['done', 'skipped'].includes(stop.status)).reduce((sum, stop) => sum + (stop.boxes || 0), 0);
  const canComplete = liveContext && connected && Boolean(current && state.truck?.dwelling);
  return {
    selected, vehicle, deliveries, current,
    status: liveContext ? current && state.truck?.dwelling ? '하차 중' : phaseLabels[state.phase] || '상태 확인 중' : '조회 전용',
    statusTone: liveContext && state.phase === 'done' ? 'done' : liveContext && current ? 'active' : 'idle',
    destination: liveContext ? state.phase === 'done' ? '금일 배송 완료' : current?.name || '물류센터 출발 대기' : selected?.name || '배송지',
    address: liveContext ? state.phase === 'done' ? '모든 배송을 완료했습니다.' : current?.address || '배송 출발 전입니다.' : selected?.address || '배송지 정보 없음',
    distance: current ? state.truck?.dwelling ? '도착' : distanceText(state.truck?.remainingM) : '—',
    boxes: current?.boxes ? `${current.boxes}박스` : `${remainingBoxes}박스`,
    progress: `${done}/${deliveries.length}`,
    remainingBoxes,
    finishEta: liveContext ? state.kpi?.finishEta || '—' : '—',
    canComplete,
    actionNote: canComplete ? `${current.name} 하차 완료를 현재 시각에 기록합니다.` : current ? '차량 도착 후 완료할 수 있습니다.' : liveContext ? '현재 완료할 배송이 없습니다.' : '조회 전용 차량은 배송 완료 처리할 수 없습니다.',
  };
}

export function driverTipDelivery(state, selectedId) {
  const fleet = state?.fleetDeliveries?.length ? state.fleetDeliveries : state?.deliveries || [];
  return fleet.find(delivery => delivery.id === selectedId)
    ?? fleet.find(delivery => delivery.id === state?.customerStopId)
    ?? fleet[0]
    ?? null;
}

export function reconcileDriverRoute(previousCompleted, completed, group) {
  const changed = previousCompleted !== null && previousCompleted !== completed;
  return {
    changed,
    completed,
    group: group === null || changed ? (completed ? 'completed' : 'active') : group,
  };
}

export function driverMapDelivery(deliveries, selectedId) {
  return deliveries.find(stop => stop.id === selectedId && stop.status !== 'skipped')
    ?? deliveries.find(stop => stop.status === 'current')
    ?? deliveries.find(stop => stop.status === 'pending')
    ?? deliveries.find(stop => stop.status !== 'skipped')
    ?? null;
}

export function completionProofIsCurrent(state, stopId) {
  return Boolean(state?.truck?.dwelling && state?.deliveries?.some(stop => stop.id === stopId && stop.status === 'current'));
}
