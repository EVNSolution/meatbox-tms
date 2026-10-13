// UI inspection samples, not a scenario engine or ETA calculator.
// Replace this data boundary with Sanghyun's agreed query results when available.
export const demoDate = '2026. 09. 16. 수요일';
export const scenarioOptions = [
  { id: 'preparing', label: '상차 대기', code: 'S1' },
  { id: 'departure', label: '배송 출발', code: 'S2' },
  { id: 'reordered', label: '순서 변경', code: 'S3' },
  { id: 'traffic', label: '교통 지연', code: 'S4' },
  { id: 'stop-delay', label: '정차 지연', code: 'S5' },
  { id: 'nearby', label: '인근 배송', code: 'S6' },
  { id: 'completed', label: '배송 완료', code: 'S6' },
  { id: 'stale', label: '갱신 실패', code: 'S7' },
];

const baselineEta = { start: '13:00', end: '14:00', updatedAt: '11:30' };
const departureEvents = [
  { at: '11:20', title: '상차 대기', detail: '도착 예정 시간 미확정', kind: '배송 단계' },
  { at: '11:30', title: '배송 출발', detail: '도착 예정 13:00 ~ 14:00 · 현재 계획 순서 5번째', kind: '배송 단계' },
];
const notification = (title, body, at) => ({ title, body, at, receivedAt: null });
const base = {
  stage: '배송 출발', status: 'in_transit', etaStatus: 'ready', eta: baselineEta,
  previousEta: null, sequence: 5, nearby: false, changed: false, changeText: null,
  reason: null, updatedAt: '11:30', snapshotTime: '11:30',
  actualArrivalAt: null, completedAt: null, refreshFailed: false,
  events: departureEvents,
  deviceNotice: notification('배송이 시작되었습니다.', '도착 예정 시간은 13:00 ~ 14:00입니다. 현재 계획 순서는 5번째입니다.', '11:30'),
  customerNotice: notification('상품 배송이 시작되었습니다.', '오늘 13:00 ~ 14:00 도착 예정입니다.', '11:30'),
};

const scenarios = {
  preparing: {
    ...base, stage: '상차 대기', status: 'preparing', etaStatus: 'unknown', eta: null,
    sequence: null, updatedAt: '11:20', snapshotTime: '11:20', events: [departureEvents[0]],
    deviceNotice: null, customerNotice: null,
  },
  departure: base,
  reordered: {
    ...base, sequence: 3, changed: true, changeText: '20분 앞당겨짐', reason: '배송 순서 변경',
    eta: { start: '12:40', end: '13:40', updatedAt: '11:40' }, previousEta: baselineEta,
    updatedAt: '11:40', snapshotTime: '11:40',
    events: [...departureEvents, { at: '11:40', title: '배송 순서 변경 · 합성 사건', detail: '계획 순서 5 → 3번째 · 도착 예정 12:40 ~ 13:40', kind: 'ETA 변경' }],
    deviceNotice: notification('배송 순서와 도착 예정 시간이 변경되었습니다.', '현재 계획 순서 3번째 · 도착 예정 12:40 ~ 13:40', '11:40'),
    customerNotice: null,
  },
  traffic: {
    ...base, changed: true, changeText: '20분 늦어짐', reason: '교통 지연',
    eta: { start: '13:20', end: '14:20', updatedAt: '11:45' }, previousEta: baselineEta,
    updatedAt: '11:45', snapshotTime: '11:45',
    events: [...departureEvents, { at: '11:45', title: '교통 지연 · 합성 사건', detail: '도착 예정 13:00 ~ 14:00 → 13:20 ~ 14:20', kind: 'ETA 변경' }],
    deviceNotice: notification('도착 예정 시간이 변경되었습니다.', '교통 지연 · 도착 예정 13:20 ~ 14:20 · 이전 안내보다 20분 늦어짐', '11:45'),
    customerNotice: notification('도착 예정 시간이 변경되었습니다.', '교통 지연으로 오늘 13:20 ~ 14:20 도착 예정입니다. 이전 안내보다 20분 늦어질 예정입니다.', '11:45'),
  },
  'stop-delay': {
    ...base, changed: true, changeText: '30분 늦어짐', reason: '앞 배송지 정차 지연',
    eta: { start: '13:30', end: '14:30', updatedAt: '11:50' }, previousEta: baselineEta,
    updatedAt: '11:50', snapshotTime: '11:50',
    events: [...departureEvents, { at: '11:50', title: '앞 배송지 정차 지연 · 합성 사건', detail: '도착 예정 13:30 ~ 14:30 · 이전 안내보다 30분 늦어짐', kind: 'ETA 변경' }],
    deviceNotice: notification('도착 예정 시간이 변경되었습니다.', '앞 배송지 정차 지연 · 도착 예정 13:30 ~ 14:30', '11:50'),
    customerNotice: notification('도착 예정 시간이 변경되었습니다.', '앞 배송지 정차 지연으로 오늘 13:30 ~ 14:30 도착 예정입니다.', '11:50'),
  },
  nearby: {
    ...base, nearby: true, updatedAt: '13:20', snapshotTime: '13:20',
    events: [...departureEvents, { at: '13:20', title: '인근 배송 · 합성 사건', detail: '인근 진행 정보 표본 · 거리와 위치 정보는 제공하지 않음', kind: '진행 정보' }],
    deviceNotice: notification('인근 배송 진행 정보가 반영되었습니다.', '도착 예정 13:00 ~ 14:00 · 합성 인근 사건', '13:20'),
    customerNotice: notification('인근에서 배송 중입니다.', '도착 예정 시간은 13:00 ~ 14:00입니다.', '13:20'),
  },
  completed: {
    ...base, stage: '배송 완료', status: 'completed', etaStatus: 'completed',
    completedAt: '13:42', updatedAt: '13:42', snapshotTime: '13:42',
    events: [...departureEvents,
      { at: '13:20', title: '인근 배송 · 합성 사건', detail: '인근 진행 정보 표본', kind: '진행 정보' },
      { at: '13:42', title: '배송 완료 · 합성 사건', detail: '완료 시각 13:42 · 실제 도착 시각 미확인', kind: '배송 단계' }],
    deviceNotice: notification('배송 완료 상태가 반영되었습니다.', '완료 시각 13:42 · 실제 도착 시각은 제공되지 않았습니다.', '13:42'),
    customerNotice: notification('배송이 완료되었습니다.', '오늘 13:42 배송 완료로 안내드립니다.', '13:42'),
  },
  stale: {
    ...base, etaStatus: 'stale', refreshFailed: true, snapshotTime: '11:50',
    events: [...departureEvents, { at: '11:50', title: '배송 정보 갱신 실패 · 합성 표본', detail: '마지막 ETA와 갱신 시각 11:30을 유지합니다.', kind: '정보 확인' }],
    deviceNotice: notification('최신 배송 정보 확인이 필요합니다.', '새 정보를 확인하지 못했습니다. 마지막 도착 예정 시간은 13:00 ~ 14:00이며 11:30에 갱신되었습니다.', '11:50'),
    customerNotice: null,
  },
};

const devices = [
  { id: 'TMS-001', vehicle: '가상 차량 01', deliveryId: 'DEMO-001', customer: '가상 식당 A' },
  { id: 'TMS-002', vehicle: '가상 차량 02', deliveryId: 'DEMO-002', customer: '가상 식당 B' },
  { id: 'TMS-003', vehicle: '가상 차량 03', deliveryId: 'DEMO-003', customer: '가상 식당 C' },
  { id: 'TMS-004', vehicle: '가상 차량 04', deliveryId: 'DEMO-004', customer: '가상 식당 D' },
];

const otherResults = [
  { ...scenarios.preparing, updatedAt: '11:10', snapshotTime: '11:15', events: [{ at: '11:10', title: '상차 대기', detail: '도착 예정 시간 확인 중', kind: '배송 단계' }] },
  { ...scenarios.completed, eta: null, sequence: null, updatedAt: '11:05', completedAt: '11:05', snapshotTime: '11:15', events: [{ at: '11:05', title: '배송 완료', detail: '실제 도착 시각 미확인', kind: '배송 단계' }], deviceNotice: notification('배송 완료 상태가 반영되었습니다.', '완료 시각 11:05 · 실제 도착 시각 미확인', '11:05'), customerNotice: notification('배송이 완료되었습니다.', '오늘 11:05 배송 완료로 안내드립니다.', '11:05') },
  { ...scenarios.stale, eta: { start: '13:10', end: '14:10', updatedAt: '11:00' }, sequence: 2, updatedAt: '11:00', snapshotTime: '11:15', events: [{ at: '11:00', title: '배송 출발', detail: '도착 예정 13:10 ~ 14:10', kind: '배송 단계' }, { at: '11:15', title: '갱신 실패 표본', detail: '마지막 배송 정보는 11:00 기준입니다.', kind: '정보 확인' }], deviceNotice: notification('최신 배송 정보 확인이 필요합니다.', '마지막 ETA 13:10 ~ 14:10 · 마지막 갱신 11:00', '11:15') },
];

export function getTerminalSnapshots(scenarioId = 'traffic') {
  if (!Object.hasOwn(scenarios, scenarioId)) throw new Error('지원하지 않는 시연 표본입니다.');
  return devices.map((device, index) => structuredClone({
    ...device, ...(index === 0 ? scenarios[scenarioId] : otherResults[index - 1]),
    deviceConnection: null, deviceReceivedAt: null,
    resultVersion: index === 0 ? `sample:${scenarioId}` : `sample:terminal-${index + 1}`,
  }));
}

export function filterTerminals(terminals, query = '', status = 'all') {
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  return terminals.filter(terminal => {
    const matchesQuery = [terminal.id, terminal.vehicle, terminal.deliveryId, terminal.customer]
      .some(value => value.toLocaleLowerCase('ko-KR').includes(needle));
    const matchesStatus = status === 'all' || terminal.status === status ||
      (status === 'needs_check' && ['unknown', 'stale'].includes(terminal.etaStatus));
    return matchesQuery && matchesStatus;
  });
}
