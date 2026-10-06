const capitals = [
  ['서울 강서', 126.8495, 37.5509],
  ['서울 송파', 127.1059, 37.5145],
  ['서울 금천', 126.8955, 37.4569],
  ['인천 남동', 126.7315, 37.4473],
  ['인천 계양', 126.7377, 37.5372],
  ['경기 고양', 126.8320, 37.6584],
  ['경기 성남', 127.1378, 37.4200],
  ['경기 수원', 127.0286, 37.2636],
  ['경기 용인', 127.1776, 37.2411],
  ['경기 부천', 126.7660, 37.5034],
  ['경기 안양', 126.9568, 37.3943],
  ['경기 남양주', 127.2165, 37.6360],
];
const plateLetters = ['가', '나', '다', '라', '마', '거', '너', '더', '러', '머', '버', '서', '어', '저'];

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.codePointAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function validateDay(day) {
  if (day?.schemaVersion !== 1 || typeof day.date !== 'string' || !Array.isArray(day.groups) || !Array.isArray(day.orders)) {
    throw new TypeError('배차 원본 자료 형식이 올바르지 않습니다.');
  }
  const groupIds = new Set();
  for (const group of day.groups) {
    if (!group?.id || groupIds.has(group.id) || typeof group.label !== 'string' || !Array.isArray(group.regionNames)) {
      throw new TypeError('배차 기사 자료를 확인해 주세요.');
    }
    groupIds.add(group.id);
  }
  const orderIds = new Set();
  for (const order of day.orders) {
    if (!order?.id || orderIds.has(order.id) || !groupIds.has(order.groupId) || !Number.isFinite(order.boxes) || order.boxes < 0) {
      throw new TypeError('배차 주문 자료를 확인해 주세요.');
    }
    orderIds.add(order.id);
  }
  return { groupIds, orderIds };
}

function demoVehicle(group) {
  const seed = hash(group.id);
  const [label, longitude, latitude] = capitals[seed % capitals.length];
  const offsetX = (((seed >>> 8) % 101) - 50) / 10000;
  const offsetY = (((seed >>> 16) % 101) - 50) / 10000;
  return {
    id: group.id,
    driver: group.label,
    plate: `${11 + (seed % 89)}${plateLetters[(seed >>> 7) % plateLetters.length]} ${String(1000 + ((seed >>> 12) % 9000)).padStart(4, '0')}`,
    region: group.regionNames.join(', '),
    live: false,
    source: 'demo-vehicle',
    location: {
      coordinates: [Number((longitude + offsetX).toFixed(6)), Number((latitude + offsetY).toFixed(6))],
      label: `${label} 예시 위치`,
      source: 'demo',
    },
  };
}

export function createDispatchFleet(day) {
  validateDay(day);
  return day.groups.map(demoVehicle);
}

export function createDispatchAssignments(day, { storage, sourceId = 'default' } = {}) {
  const { groupIds, orderIds } = validateDay(day);
  if (typeof sourceId !== 'string') throw new TypeError('자료 식별자를 확인해 주세요.');
  const byId = new Map(day.orders.map(order => [order.id, order]));
  const overrides = new Map();
  const key = `meatbox.dispatch.assignments.v1:${encodeURIComponent(sourceId)}:${day.date}`;
  let restored = false;

  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  try {
    const raw = storage?.getItem(key);
    if (raw) {
      const record = JSON.parse(raw);
      const entries = Object.entries(record.overrides || {});
      if (record.schemaVersion !== 1 || record.sourceId !== sourceId || record.date !== day.date
        || entries.some(([orderId, groupId]) => !orderIds.has(orderId) || !groupIds.has(groupId))) {
        throw new TypeError('저장된 배차 자료가 현재 원본과 일치하지 않습니다.');
      }
      for (const [orderId, groupId] of entries) {
        if (byId.get(orderId).groupId !== groupId) overrides.set(orderId, groupId);
      }
      restored = true;
    }
  } catch { /* 손상되거나 현재 자료와 다른 로컬 배차는 사용하지 않습니다. */ }

  const currentGroup = orderId => overrides.get(orderId) || byId.get(orderId).groupId;
  return {
    restored,
    orders() {
      return day.orders.map(order => ({
        ...order,
        originalGroupId: order.groupId,
        currentGroupId: currentGroup(order.id),
      }));
    },
    assign(ids, targetGroupId) {
      if (!groupIds.has(targetGroupId)) throw new TypeError('배차 대상 기사를 확인해 주세요.');
      if (!Array.isArray(ids) || ids.length === 0) throw new TypeError('재배정할 주문을 선택해 주세요.');
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.some(orderId => !orderIds.has(orderId))) throw new TypeError('재배정 주문을 확인해 주세요.');
      const changed = uniqueIds.filter(orderId => currentGroup(orderId) !== targetGroupId);
      if (!changed.length) throw new Error('선택한 주문은 이미 해당 기사에게 배차되어 있습니다.');

      for (const orderId of changed) {
        if (byId.get(orderId).groupId === targetGroupId) overrides.delete(orderId);
        else overrides.set(orderId, targetGroupId);
      }
      let persisted = false;
      try {
        storage?.setItem(key, JSON.stringify({
          schemaVersion: 1,
          sourceId,
          date: day.date,
          overrides: Object.fromEntries(overrides),
        }));
        persisted = Boolean(storage);
      } catch { /* 메모리의 재배정 결과는 유지합니다. */ }
      return {
        changedCount: changed.length,
        changedBoxes: changed.reduce((sum, orderId) => sum + byId.get(orderId).boxes, 0),
        persisted,
      };
    },
  };
}
