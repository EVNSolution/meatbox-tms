const phaseLabels = { unordered: '배차 대기', idle: '배차 대기', preparing: '상차 중', delivering: '배송 중', done: '배송 완료' };
const distanceText = metres => Number.isFinite(metres) ? metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m` : '이동 중';

export function driverViewModel(state, connected = true) {
  const current = state.deliveries.find(stop => stop.status === 'current') ?? null;
  const done = state.deliveries.filter(stop => stop.status === 'done').length;
  const remainingBoxes = state.deliveries.filter(stop => !['done', 'skipped'].includes(stop.status)).reduce((sum, stop) => sum + (stop.boxes || 0), 0);
  const canComplete = connected && Boolean(current && state.truck?.dwelling);
  return {
    current,
    status: current && state.truck?.dwelling ? '하차 중' : phaseLabels[state.phase] || '상태 확인 중',
    statusTone: state.phase === 'done' ? 'done' : current ? 'active' : 'idle',
    destination: state.phase === 'done' ? '금일 배송 완료' : current?.name || '물류센터 출발 대기',
    address: state.phase === 'done' ? '모든 배송을 완료했습니다.' : current?.address || '배송 출발 전입니다.',
    distance: current ? state.truck?.dwelling ? '도착' : distanceText(state.truck?.remainingM) : '—',
    boxes: current?.boxes ? `${current.boxes}박스` : `${remainingBoxes}박스`,
    progress: `${done}/${state.deliveries.length}`,
    remainingBoxes,
    finishEta: state.kpi?.finishEta || '—',
    canComplete,
    actionNote: canComplete ? `${current.name} 하차 완료를 현재 시각에 기록합니다.` : current ? '차량 도착 후 완료할 수 있습니다.' : '현재 완료할 배송이 없습니다.',
  };
}
