const preparation = [
  { key: 'order', label: '주문 접수', time: '05:45', description: '고객 주문과 결제를 접수합니다.' },
  { key: 'picking', label: '피킹 중', time: '05:50', description: 'MFC에서 배송할 상품을 모읍니다. 고객 화면도 피킹 중으로 바뀝니다.' },
  { key: 'labeling', label: '라벨 부착', time: '06:05', description: '상품에 배송 라벨을 붙이고 배송지를 구분합니다.' },
  { key: 'staged', label: '상차 대기', time: '06:20', description: '상품 준비를 마치고 차량 상차를 기다립니다.' },
  { key: 'departed', label: '배송 출발', time: '06:30', description: '차량이 출발합니다. 고객별 공식 ETA와 출발 안내가 갱신됩니다.' },
];

const minutes = time => /^\d{2}:\d{2}$/.test(time || '') ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null;
const stopName = stop => `${stop.sequence}번 ${stop.name}`;

export function scenarioGuide(state) {
  if (!state) return null;
  const current = state.deliveries.find(stop => stop.status === 'current');
  const completed = state.deliveries.filter(stop => stop.status === 'done');
  const latestCompleted = completed.at(-1) ?? null;
  const upcoming = state.deliveries.find(stop => stop.status === 'pending');
  const nextPrep = preparation.find(step => step.key === state.nextStep?.key);
  const prepIndex = nextPrep ? preparation.indexOf(nextPrep) - 1 : ['delivering', 'done'].includes(state.phase) ? preparation.length : -1;
  const timeline = state.deliveries.find(stop => stop.id === state.customerStopId)?.timeline ?? [];
  const steps = preparation.map((step, index) => ({
    ...step,
    actualTime: timeline.find(item => item.label === (step.key === 'departed' ? '배송 중' : step.label))?.time ?? null,
    state: index < prepIndex ? 'done' : index === prepIndex ? 'current' : 'pending',
  }));
  let guide;
  if (state.phase === 'unordered') {
    guide = { title: '고객 주문 대기', description: '주문 접수부터 첫 배송지 완료까지 한 단계씩 시연합니다.', action: 'place_order', actionLabel: '주문 접수하기', nextTitle: '주문 접수', nextTime: state.simClock, effect: '시연 고객의 주문과 결제가 접수되고 고객 배송 안내가 시작됩니다.' };
  } else if (nextPrep) {
    const previous = preparation[prepIndex];
    guide = { title: previous.label, description: previous.description, action: 'advance', actionLabel: { picking: '피킹 시작', labeling: '라벨 부착 처리', staged: '상차 대기로 진행', departed: '배송 출발' }[nextPrep.key], nextTitle: nextPrep.label, nextTime: nextPrep.time, effect: nextPrep.description };
  } else if (state.phase === 'delivering' && current) {
    if (state.truck?.dwelling) {
      const remaining = Math.ceil(state.truck.dwellRemaining / 60);
      guide = { title: `${stopName(current)} 하차 중`, description: `${current.arrivedAt || '시각 미확인'} 도착. 하차·검수 시간이 약 ${remaining}분 남았습니다.`, action: 'complete_stop', stopId: current.id, actionLabel: `${current.sequence}번 배송 완료 처리`, nextTitle: '하차 완료 스캔', nextTime: state.simClock, effect: `지금 시각으로 배송 완료를 기록합니다. ${upcoming ? `다음 목적지 ${stopName(upcoming)} 배송을 시작하고 남은 ETA를 다시 계산합니다.` : '남은 배송이 없으면 시연을 마칩니다.'}` };
    } else {
      guide = { title: `${stopName(current)} 이동 중`, description: '차량이 자동 주행 중입니다. 기다리거나 도착까지 시간을 진행할 수 있습니다.', action: 'arrive_stop', stopId: current.id, actionLabel: `${current.sequence}번 도착까지 시간 진행`, nextTitle: `${current.sequence}번 배송지 도착`, nextTime: current.calculatedEta, estimated: true, effect: '이동과 교통 지연을 반영해 도착 시각까지 진행합니다. 도착 후 하차와 배송 완료를 따로 확인합니다.' };
    }
  } else if (state.phase === 'done') {
    guide = { title: '배송 시연 완료', description: `${completed.length}곳의 배송을 완료했습니다.${state.deliveries.some(stop => stop.status === 'skipped') ? ' 건너뛴 배송지는 완료 건수에서 제외됩니다.' : ''}`, nextTitle: '전체 배송 결과 확인', effect: '배송 목록에서 각 배송지의 도착·완료 시각을 확인하거나 초기화해 다시 시연합니다.' };
  } else {
    guide = { title: '진행 상태 확인 중', description: '다음 상태를 기다립니다.', nextTitle: '상태 연결 확인', effect: '연결이 복구되면 현재 단계에 맞는 행동을 안내합니다.' };
  }
  const delta = minutes(guide.nextTime) - minutes(state.simClock);
  return {
    ...guide, steps, current, latestCompleted,
    elapsed: guide.action === 'complete_stop' ? '현재 시각에 완료 스캔'
      : guide.action === 'place_order' ? '시연 시작'
        : minutes(guide.nextTime) !== null && minutes(state.simClock) !== null && delta >= 0 ? `시연 시간 +${delta}분${guide.estimated ? ' 예상' : ''}` : null,
    doneCount: completed.length,
    totalCount: state.deliveries.filter(stop => stop.status !== 'skipped').length,
    recentEvents: state.events.filter(event => event.type !== 'notify').slice(0, 3),
  };
}
