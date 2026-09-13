const escapeText = value => String(value ?? '');

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
  delivered: 'green',
  held: 'amber',
})[status] ?? 'neutral';

export function adaptSimulation(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.order)) {
    throw new TypeError('시뮬레이션 상태에 order 배열이 필요합니다.');
  }

  const liveVehicle = snapshot.vehicles?.find(vehicle => vehicle.live) ?? null;
  const deliveries = snapshot.order.map((stop, index) => {
    const customer = snapshot.customers?.[stop.id] ?? null;
    const officialEta = customer?.eta ?? null;
    const notices = Array.isArray(snapshot.notifications)
      ? snapshot.notifications.filter(notice => notice.stopId === stop.id)
      : [];

    return {
      id: escapeText(stop.id),
      name: escapeText(stop.name),
      address: escapeText(stop.address),
      boxes: Number.isFinite(stop.boxes) ? stop.boxes : null,
      items: Array.isArray(stop.items) ? stop.items : [],
      sequence: index + 1,
      status: escapeText(stop.status || 'pending'),
      statusTone: statusTone(stop.status),
      customerStatus: customer?.status ?? { key: 'unknown', label: '미확인' },
      customerStatusTone: customerTone(customer?.status?.key),
      ordered: customer?.ordered === true,
      officialEta: officialEta ? {
        time: escapeText(officialEta.timeText),
        reason: escapeText(officialEta.reason),
        deltaMin: Number.isFinite(officialEta.deltaMin) ? officialEta.deltaMin : null,
        updatedAt: formatSimTime(officialEta.updatedAt),
      } : null,
      calculatedEta: stop.eta ? escapeText(stop.eta) : null,
      arrivedAt: stop.arrivedTime ? escapeText(stop.arrivedTime) : null,
      completedAt: stop.deliveredTime ? escapeText(stop.deliveredTime) : null,
      timeline: Array.isArray(customer?.timeline)
        ? customer.timeline.map(item => ({
          label: escapeText(item.label),
          time: item.time ? escapeText(item.time) : null,
          state: escapeText(item.state),
        }))
        : [],
      notices: notices.map(notice => ({
        title: escapeText(notice.title),
        body: escapeText(notice.body),
        time: notice.time ? escapeText(notice.time) : null,
      })),
    };
  });

  return {
    phase: escapeText(snapshot.phase),
    simClock: escapeText(snapshot.simClock),
    speed: snapshot.speed,
    customerStopId: snapshot.customerStopId ? escapeText(snapshot.customerStopId) : null,
    vehicle: liveVehicle ? {
      id: escapeText(liveVehicle.id),
      plate: escapeText(liveVehicle.plate),
      driver: escapeText(liveVehicle.driver),
      region: escapeText(liveVehicle.region),
    } : null,
    device: null,
    deliveries,
    events: Array.isArray(snapshot.events) ? snapshot.events.map(event => ({
      time: event.time ? escapeText(event.time) : null,
      type: escapeText(event.type),
      message: escapeText(event.message),
    })) : [],
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

export const publishedEtaText = delivery => delivery?.ordered ? officialEtaText(delivery) : '미확인';

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
    delivered: '배송이 완료되었습니다.',
    held: '배송이 보류되었습니다.',
  })[delivery.customerStatus?.key] ?? `${delivery.customerStatus?.label || '배송'} 상태입니다.`;
}
