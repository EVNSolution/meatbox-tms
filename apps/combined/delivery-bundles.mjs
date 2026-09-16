const text = value => String(value ?? '').normalize('NFC').trim();

export function destinationKey(stop) {
  const name = text(stop?.name);
  const address = text(stop?.address);
  return name && address ? JSON.stringify([name, address]) : JSON.stringify(['order', text(stop?.id)]);
}

const statusOf = orders => orders.some(order => order.status === 'current') ? 'current'
  : orders.some(order => order.status === 'pending') ? 'pending'
    : orders.some(order => order.status === 'skipped') ? 'skipped'
      : orders.every(order => order.status === 'done') ? 'done' : 'pending';

const toneOf = status => ({ current: 'blue', done: 'green', pending: 'neutral', skipped: 'neutral' })[status] ?? 'neutral';
const customerState = (status, arrived) => status === 'done' ? { key: 'delivered', label: '배송 완료' }
  : status === 'current' ? arrived ? { key: 'arrived', label: '배송지 도착' } : { key: 'shipping', label: '배송 중' }
    : status === 'skipped' ? { key: 'held', label: '배송 보류' } : { key: 'paid', label: '결제 완료' };
const customerTone = status => ({ current: 'blue', done: 'green', pending: 'neutral', skipped: 'amber' })[status] ?? 'neutral';

function uniqueMetadata(orders, field, key) {
  const seen = new Set();
  return orders.flatMap(order => Array.isArray(order[field]) ? order[field].map(item => ({ ...item,
    sourceOrderId: item.sourceOrderId ?? order.id,
  })) : []).filter(item => {
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function customerRequests(orders) {
  const requests = orders.flatMap(order => order.customerRequests?.items || []);
  if (!requests.length && orders.every(order => order.customerRequests == null)) return null;
  const seen = new Set();
  return {
    source: [...new Set(orders.map(order => order.customerRequests?.source).filter(Boolean))].join(', '),
    items: requests.filter(item => !seen.has(item.id) && seen.add(item.id)).map(item => ({ ...item })),
  };
}

function dateKey(stop) {
  return text(stop?.sourceDate ?? stop?.deliveryDate ?? stop?.date);
}

export function bundleDeliveries(deliveries = []) {
  if (!Array.isArray(deliveries)) return [];
  if (deliveries.every(delivery => Array.isArray(delivery?.orders) && Array.isArray(delivery?.orderIds))) return deliveries;
  const groups = new Map();
  for (const order of deliveries) {
    const key = JSON.stringify([dateKey(order), text(order?.vehicleId ?? order?.vehicle?.id), destinationKey(order)]);
    const group = groups.get(key) || [];
    group.push(order);
    groups.set(key, group);
  }
  const sequences = new Map();
  return [...groups.values()].map(orders => {
    const representative = orders[0];
    const routeKey = JSON.stringify([dateKey(representative), text(representative?.vehicleId ?? representative?.vehicle?.id)]);
    const sequence = (sequences.get(routeKey) ?? 0) + 1;
    sequences.set(routeKey, sequence);
    const status = statusOf(orders);
    const statusOrders = orders.filter(order => order.status === status);
    const active = statusOrders.find(order => order.arrivedAt || order.completedAt) ?? statusOrders[0] ?? representative;
    const notices = uniqueMetadata(orders, 'notices', item => item.id || JSON.stringify([item.kind, item.time, item.title, item.body]))
      .map(item => ({ ...item, stopId: representative.id }));
    const timeline = uniqueMetadata(orders, 'timeline', item => JSON.stringify([item.label, item.time, item.state]));
    const boxes = orders.every(order => Number.isFinite(order.boxes) && order.boxes >= 0)
      ? orders.reduce((sum, order) => sum + order.boxes, 0) : null;
    const requests = customerRequests(orders);
    const arrivedAt = ['current', 'done'].includes(status)
      ? statusOrders.map(order => order.arrivedAt).find(Boolean) ?? null : null;
    return {
      ...representative,
      sequence,
      boxes,
      status,
      statusTone: toneOf(status),
      orderIds: orders.map(order => order.id),
      orders: orders.map(order => ({ ...order })),
      notices,
      timeline,
      customerRequests: requests,
      customerStatus: active.customerStatus ?? customerState(status, arrivedAt),
      customerStatusTone: active.customerStatusTone ?? customerTone(status),
      arrivedAt,
      completedAt: status === 'done' ? orders.map(order => order.completedAt).filter(Boolean).at(-1) ?? null : null,
    };
  });
}
