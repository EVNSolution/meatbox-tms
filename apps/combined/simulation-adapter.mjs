const escapeText = value => String(value ?? '');

function noticeTitle(notice) {
  const title = escapeText(notice.title);
  // Preserve existing demo history and manual copy while removing retired automatic decorations.
  if (['shipping', 'departure'].includes(notice.kind) && title === '배송이 출발했습니다 🚚') return '배송이 출발했습니다';
  if (['completed', 'complete'].includes(notice.kind) && title === '배송이 완료되었습니다 ✅') return '배송이 완료되었습니다';
  return title;
}

export const formatSimTime = value => {
  if (!Number.isFinite(value)) return null;
  const minutes = Math.round(value / 60000);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const statusTone = status => ({
  current: 'blue',
  done: 'green',
  skipped: 'neutral',
  pending: 'neutral',
})[status] ?? 'neutral';

const customerTone = status => ({
  shipping: 'blue',
  nearby: 'blue',
  arrived: 'blue',
  delivered: 'green',
  held: 'amber',
})[status] ?? 'neutral';

function adaptOperationEvent(event) {
  let type = escapeText(event.type);
  let message = escapeText(event.message);
  // Keep the running local session's older records readable without resetting its state.
  if (type === 'system') {
    const selected = /^수동 상태 선택: (.+) · (주문 접수|피킹 중|출고 준비|배송 중|도착|배송 완료)$/.exec(message);
    if (selected) {
      const action = { '주문 접수': '주문 접수 완료', '피킹 중': '피킹 시작', '출고 준비': '출고 준비 완료', '배송 중': '배송 출발', '도착': '도착', '배송 완료': '배송 완료' }[selected[2]];
      message = `${selected[1]} ${action}`;
      type = 'stage';
    } else if (message.startsWith('주문 접수 완료 — 출고 준비 시작')) {
      message = '주문 접수 완료';
      type = 'stage';
    } else if (/^(시나리오|시뮬레이션|수동 상태 선택:)/.test(message)) {
      return null;
    }
  }
  return {
    ...(Object.hasOwn(event, 'id') ? { id: event.id } : {}),
    ...(Object.hasOwn(event, 'ts') ? { ts: event.ts } : {}),
    ...(Object.hasOwn(event, 'vehicleId') ? { vehicleId: escapeText(event.vehicleId) } : {}),
    ...(Object.hasOwn(event, 'stopId') ? { stopId: escapeText(event.stopId) } : {}),
    ...(Object.hasOwn(event, 'action') ? { action: escapeText(event.action) } : {}),
    time: event.time ? escapeText(event.time) : null,
    type,
    message,
  };
}

export function adaptSimulation(snapshot) {
  if (snapshot?.sourceData) {
    if (!Array.isArray(snapshot.fleetDeliveries) || !Array.isArray(snapshot.fleetVehicles) || !snapshot.vehicleStates) throw new TypeError('배송 자료를 확인해 주세요.');
    return snapshot;
  }
  if (!snapshot || !Array.isArray(snapshot.order)) {
    throw new TypeError('배송 상태에 order 배열이 필요합니다.');
  }

  const liveVehicle = snapshot.vehicles?.find(vehicle => vehicle.live) ?? null;
  const vehicles = Array.isArray(snapshot.fleet?.vehicles) ? snapshot.fleet.vehicles : (snapshot.vehicles ?? []);
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const adaptVehicle = vehicle => vehicle ? {
    id: escapeText(vehicle.id),
    plate: escapeText(vehicle.plate),
    driver: escapeText(vehicle.driver),
    region: escapeText(vehicle.region),
    live: vehicle.live === true,
    status: escapeText(vehicle.status),
    planned: vehicle.planned ?? null,
    capacityBoxes: Number.isFinite(vehicle.capacityBoxes) ? vehicle.capacityBoxes : null,
    departure: vehicle.departure ? {
      time: escapeText(vehicle.departure.time),
      source: escapeText(vehicle.departure.source),
    } : null,
  } : null;
  const noticesByStop = new Map();
  for (const notice of Array.isArray(snapshot.notifications) ? snapshot.notifications : []) {
    const adapted = {
      id: notice.id,
      ...(Object.hasOwn(notice, 'ts') ? { ts: notice.ts } : {}),
      stopId: escapeText(notice.stopId),
      title: noticeTitle(notice),
      body: escapeText(notice.body),
      time: notice.time ? escapeText(notice.time) : null,
      clock: notice.clock ? escapeText(notice.clock) : (notice.time ? escapeText(notice.time) : null),
      kind: escapeText(notice.kind),
      channel: escapeText(notice.channel),
      status: escapeText(notice.status),
      author: notice.author ? escapeText(notice.author) : null,
    };
    const notices = noticesByStop.get(adapted.stopId) || [];
    notices.push(adapted);
    noticesByStop.set(adapted.stopId, notices);
  }
  const adaptNotices = stopId => noticesByStop.get(stopId) || [];
  const deliveries = snapshot.order.map((stop, index) => {
    const customer = snapshot.customers?.[stop.id] ?? null;
    const officialEta = customer?.eta ?? null;
    const vehicle = vehicleById.get(stop.vehicleId) ?? liveVehicle;
    const arrived = Boolean(stop.arrivedTime && ['current', 'done'].includes(stop.status));
    const customerStatus = arrived && stop.status === 'current' ? { key: 'arrived', label: '배송지 도착' }
      : customer?.status ?? { key: 'unknown', label: '미확인' };

    return {
      id: escapeText(stop.id),
      name: escapeText(stop.name),
      address: escapeText(stop.address),
      boxes: Number.isFinite(stop.boxes) ? stop.boxes : null,
      customerRequests: stop.customerRequests && Array.isArray(stop.customerRequests.items) ? {
        source: escapeText(stop.customerRequests.source),
        items: stop.customerRequests.items.map(item => ({ id: escapeText(item.id), kind: escapeText(item.kind), label: escapeText(item.label), required: item.required === true })),
      } : null,
      items: Array.isArray(stop.items) ? stop.items : [],
      sequence: index + 1,
      status: escapeText(stop.status || 'pending'),
      statusTone: statusTone(stop.status),
      customerStatus,
      customerStatusTone: customerTone(customerStatus.key),
      ordered: customer?.ordered === true,
      officialEta: officialEta ? {
        time: escapeText(officialEta.preciseTimeText || officialEta.timeText),
        windowText: escapeText(officialEta.windowText),
        reason: escapeText(officialEta.reason),
        deltaMin: Number.isFinite(officialEta.deltaMin) ? officialEta.deltaMin : null,
        updatedAt: formatSimTime(officialEta.updatedAt),
      } : null,
      calculatedEta: stop.eta ? escapeText(stop.eta) : null,
      arrivedAt: stop.arrivedTime ? escapeText(stop.arrivedTime) : null,
      completedAt: stop.deliveredTime ? escapeText(stop.deliveredTime) : null,
      timeline: Array.isArray(customer?.timeline)
        ? customer.timeline.map(item => arrived && item.label === '인근 배송 중' ? {
          label: '배송지 도착', time: escapeText(stop.arrivedTime), state: stop.status === 'done' ? 'done' : 'current',
        } : ({
          label: escapeText(item.label),
          time: item.time ? escapeText(item.time) : null,
          state: escapeText(item.state),
        }))
        : [],
      preciseTimeText: officialEta?.preciseTimeText ? escapeText(officialEta.preciseTimeText) : (stop.eta ? escapeText(stop.eta) : null),
      customerWindowText: officialEta?.windowText ? escapeText(officialEta.windowText) : null,
      customerWindowStart: officialEta?.windowStart ? escapeText(officialEta.windowStart) : null,
      customerWindowEnd: officialEta?.windowEnd ? escapeText(officialEta.windowEnd) : null,
      vehicleId: escapeText(vehicle?.id),
      vehicle: adaptVehicle(vehicle),
      notices: adaptNotices(stop.id),
      tip: stop.tip ? {
        body: escapeText(stop.tip.body),
        author: escapeText(stop.tip.author),
        updatedAt: Number.isFinite(stop.tip.updatedAt) ? formatSimTime(stop.tip.updatedAt) : null,
      } : null,
    };
  });

  const syntheticDeliveries = Array.isArray(snapshot.fleet?.deliveries) ? snapshot.fleet.deliveries.map(stop => {
    const vehicle = vehicleById.get(stop.vehicleId);
    return {
      id: escapeText(stop.id),
      name: escapeText(stop.name),
      address: escapeText(stop.address),
      boxes: Number.isFinite(stop.boxes) ? stop.boxes : null,
      items: Array.isArray(stop.items) ? stop.items : [],
      sequence: stop.sequence,
      status: escapeText(stop.status || 'pending'),
      statusTone: statusTone(stop.status),
      customerStatus: { key: 'paid', label: '결제 완료' },
      customerRequests: null,
      customerStatusTone: 'neutral',
      ordered: stop.ordered === true,
      officialEta: null,
      calculatedEta: null,
      arrivedAt: null,
      completedAt: null,
      timeline: [],
      preciseTimeText: null,
      customerWindowText: null,
      customerWindowStart: null,
      customerWindowEnd: null,
      vehicleId: escapeText(stop.vehicleId),
      vehicle: adaptVehicle(vehicle),
      notices: adaptNotices(stop.id),
      tip: stop.tip ? {
        body: escapeText(stop.tip.body),
        author: escapeText(stop.tip.author),
        updatedAt: Number.isFinite(stop.tip.updatedAt) ? formatSimTime(stop.tip.updatedAt) : null,
      } : null,
    };
  }) : [];

  return {
    phase: escapeText(snapshot.phase),
    scenarioPreset: snapshot.scenarioPreset ? escapeText(snapshot.scenarioPreset) : null,
    scenarioStopId: snapshot.scenarioStopId ? escapeText(snapshot.scenarioStopId) : null,
    simTime: Number.isFinite(snapshot.simTime) ? snapshot.simTime : null,
    simClock: escapeText(snapshot.simClock),
    speed: snapshot.speed,
    truck: snapshot.truck ? {
      lat: Number.isFinite(snapshot.truck.lat) ? snapshot.truck.lat : null,
      lng: Number.isFinite(snapshot.truck.lng) ? snapshot.truck.lng : null,
      locationSource: Number.isFinite(snapshot.truck.lat) && Number.isFinite(snapshot.truck.lng) ? 'simulation' : null,
      dwelling: snapshot.truck.dwelling === true,
      dwellRemaining: Number.isFinite(snapshot.truck.dwellRemaining) ? snapshot.truck.dwellRemaining : 0,
    } : null,
    customerStopId: snapshot.customerStopId ? escapeText(snapshot.customerStopId) : null,
    vehicle: liveVehicle ? {
      id: escapeText(liveVehicle.id),
      plate: escapeText(liveVehicle.plate),
      driver: escapeText(liveVehicle.driver),
      region: escapeText(liveVehicle.region),
      departure: liveVehicle.departure ? {
        time: escapeText(liveVehicle.departure.time),
        source: escapeText(liveVehicle.departure.source),
      } : null,
    } : null,
    device: null,
    deliveries,
    fleetVehicles: vehicles.map(adaptVehicle),
    fleetDeliveries: [...deliveries, ...syntheticDeliveries],
    events: Array.isArray(snapshot.events) ? snapshot.events.map(adaptOperationEvent).filter(Boolean) : [],
    incidents: Array.isArray(snapshot.incidents) ? snapshot.incidents.map(incident => ({
      at: Number.isFinite(incident.at) ? formatSimTime(incident.at) : null,
      label: escapeText(incident.label),
    })) : [],
    kpi: snapshot.kpi ?? {},
    nextStep: snapshot.nextStep ?? null,
  };
}

export const officialEtaText = delivery => delivery?.officialEta?.time || '미확인';
export const calculatedEtaText = delivery => delivery?.calculatedEta || '미확인';

export const publishedEtaText = delivery => delivery?.ordered ? (delivery?.customerWindowText || officialEtaText(delivery)) : '미확인';

export function customerHeadline(delivery) {
  if (delivery?.ordered === false) return '주문 접수 전입니다.';
  if (delivery.status === 'done') return '배송이 완료되었습니다.';
  if (delivery.status === 'skipped') return '배송이 보류되었습니다.';
  return ({
    paid: '결제가 완료되었습니다.',
    picking: '상품을 준비하고 있습니다.',
    labeling: '배송 라벨을 준비하고 있습니다.',
    staged: '상차를 기다리고 있습니다.',
    shipping: '상품이 배송 중입니다.',
    nearby: '인근에서 배송 중입니다.',
    arrived: '배송지에 도착했습니다.',
    delivered: '배송이 완료되었습니다.',
    held: '배송이 보류되었습니다.',
  })[delivery.customerStatus?.key] ?? `${delivery.customerStatus?.label || '배송'} 상태입니다.`;
}
