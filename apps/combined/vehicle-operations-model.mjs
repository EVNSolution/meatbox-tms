export const fleetDeliveries = data => data?.fleetDeliveries ?? data?.deliveries ?? [];

export function sumBoxes(deliveries) {
  return deliveries.every(stop => Number.isFinite(stop.boxes) && stop.boxes >= 0)
    ? deliveries.reduce((sum, stop) => sum + stop.boxes, 0) : null;
}

export function vehicleOperations(data) {
  const groups = new Map();
  for (const stop of fleetDeliveries(data)) {
    const id = stop.vehicleId || stop.vehicle?.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(stop);
  }
  const vehicles = data?.fleetVehicles ?? (data?.vehicle ? [data.vehicle] : []);
  const liveVehicleIds = vehicles.filter(vehicle => vehicle.live).map(vehicle => vehicle.id);
  return vehicles.map(vehicle => {
    const deliveries = groups.get(vehicle.id) || [];
    const liveTiming = data?.vehicleStates?.[vehicle.id]?.timing ?? data?.kpi?.vehicleTiming;
    const timingOwnerMatches = liveTiming?.vehicleId
      ? liveTiming.vehicleId === vehicle.id
      : liveVehicleIds.length === 1 && liveVehicleIds[0] === vehicle.id;
    const timing = !data?.sourceData && vehicle.live && liveTiming?.source === 'simulation' && timingOwnerMatches
      ? liveTiming : null;
    const liveOwnerMatches = liveTiming?.source === 'simulation'
      ? timingOwnerMatches : liveVehicleIds.length === 1 && liveVehicleIds[0] === vehicle.id;
    // Held assignments remain unfinished work; never hide them from the workload.
    const remaining = deliveries.filter(stop => stop.status !== 'done');
    const completed = deliveries.filter(stop => stop.status === 'done');
    return {
      vehicle, deliveries, remaining, completed,
      current: deliveries.find(stop => stop.status === 'current') ?? null,
      remainingStops: remaining.length,
      remainingBoxes: sumBoxes(remaining),
      totalBoxes: sumBoxes(deliveries),
      heldStops: remaining.filter(stop => stop.status === 'skipped').length,
      timing,
      remainingMinutes: Number.isFinite(timing?.remainingSeconds) ? Math.round(timing.remainingSeconds / 60) : null,
      durationMinutes: Number.isFinite(timing?.durationSeconds) ? Math.round(timing.durationSeconds / 60) : null,
      completionEtaMs: Number.isFinite(timing?.completionMs) ? timing.completionMs : null,
      lastArrivalEta: !data?.sourceData && vehicle.live && liveOwnerMatches && /^\d{2}:\d{2}$/.test(data?.kpi?.finishEta || '')
        ? data.kpi.finishEta : null,
    };
  });
}

export function summarizeFleetTiming(rows) {
  const totalVehicles = rows.length;
  const known = rows.map(row => row.timing).filter(timing => timing && timing.heldStops === 0
    && Number.isFinite(timing.departureMs) && Number.isFinite(timing.completionMs));
  const departureMs = known.length ? Math.min(...known.map(timing => timing.departureMs)) : null;
  const completionMs = known.length ? Math.max(...known.map(timing => timing.completionMs)) : null;
  return {
    knownVehicles: known.length,
    totalVehicles,
    departureMs,
    completionMs,
    durationMinutes: departureMs != null && completionMs != null
      ? Math.round((completionMs - departureMs) / 60000) : null,
  };
}

export function sortVehicleOperations(rows, sort = 'received') {
  if (sort === 'received') return [...rows];
  const key = { stops: 'remainingStops', boxes: 'remainingBoxes', duration: 'remainingMinutes' }[sort];
  if (!key) return [...rows];
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    return bv - av;
  });
}

export function resolveControlVehicle(rows, vehicleId, selectedId) {
  return rows.find(row => row.vehicle.id === vehicleId)
    ?? rows.find(row => row.deliveries.some(stop => stop.id === selectedId))
    ?? rows[0] ?? null;
}

export function resolveDefaultControlVehicle(data, rows, vehicleId, selectedId) {
  return resolveControlVehicle(rows, vehicleId ?? data?.sourceData?.defaultVehicleId, selectedId);
}

export function resolveControlDelivery(row, selectedId) {
  return row?.deliveries.find(stop => stop.id === selectedId)
    ?? row?.current
    ?? row?.deliveries[0]
    ?? null;
}

const timeValue = item => Number.isFinite(item.ts) ? item.ts
  : /^\d{2}:\d{2}$/.test(item.time || '') ? (Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3))) * 60000
    : Infinity;
const chronological = entries => entries.map((entry, index) => ({ ...entry, index }))
  .sort((a, b) => timeValue(a) - timeValue(b) || a.index - b.index);

export function vehicleEvents(data, vehicleId) {
  // The gateway supplies events newest-first; restore occurrence order for equal clocks.
  return chronological([...(data?.events ?? [])].reverse().filter(event => !event.stopId &&
    (event.vehicleId ? event.vehicleId === vehicleId : vehicleId === data?.vehicle?.id)));
}

export function deliveryFacts(data, stop) {
  if (!stop) return [];
  const explicit = [...(data?.events ?? [])].reverse().filter(event => event.stopId === stop.id &&
    (!event.vehicleId || event.vehicleId === stop.vehicleId));
  const facts = [...explicit];
  const labels = new Map([['주문 접수', '주문 접수 완료'], ['결제 완료', '주문 접수 완료'], ['인근 배송 중', '배송지 도착']]);
  const actions = { received: '주문 접수 완료', picking: '피킹 중', ready: '상차 대기', shipping: '배송 중', arrived: '배송지 도착', completed: '배송 완료' };
  const seen = new Set(explicit.map(event => `${event.time}|${actions[event.action] || event.message.replace(`${stop.name} `, '')}`));
  for (const item of stop.timeline ?? []) {
    if (!item.time || !['done', 'current'].includes(item.state) || /예정/.test(item.label)) continue;
    if (item.label === '인근 배송 중' && !stop.arrivedAt) continue;
    const message = labels.get(item.label) || item.label;
    const key = `${item.time}|${message}`;
    if (!seen.has(key)) { facts.push({ time: item.time, type: 'stage', message }); seen.add(key); }
  }
  for (const [time, message] of [[stop.arrivedAt, '배송지 도착'], [stop.completedAt, '배송 완료']]) {
    if (time && !seen.has(`${time}|${message}`)) facts.push({ time, type: 'stage', message });
  }
  return chronological(facts);
}

export function noticesForDelivery(stop) {
  return chronological((stop?.notices ?? []).filter(notice => notice.stopId === stop.id));
}

export function deliveryRecords(data, stop, filter = 'all') {
  if (!stop) return [];
  const usedKeys = new Map();
  const record = (kind, item) => {
    const originalKind = item.kind;
    const identity = item.id ?? `${item.ts ?? item.time ?? 'unknown'}:${item.message ?? item.title ?? ''}`;
    const baseKey = `${kind}:${identity}`;
    const occurrence = usedKeys.get(baseKey) ?? 0;
    usedKeys.set(baseKey, occurrence + 1);
    return {
      ...item,
      ...(originalKind && originalKind !== kind ? { sourceKind: originalKind } : {}),
      kind,
      key: occurrence ? `${baseKey}:${occurrence}` : baseKey,
    };
  };
  const records = chronological([
    ...deliveryFacts(data, stop).map(item => record('history', item)),
    ...noticesForDelivery(stop).map(item => record('notice', item)),
  ]);
  return ['history', 'notice'].includes(filter) ? records.filter(item => item.kind === filter) : records;
}

export function controlPosition(data, row) {
  if (data?.sourceData && row?.vehicle?.id) {
    const stateTruck = data.vehicleStates?.[row.vehicle.id]?.truck;
    const location = row.vehicle.location;
    const coordinates = Number.isFinite(stateTruck?.lng) && Number.isFinite(stateTruck?.lat)
      ? [stateTruck.lng, stateTruck.lat] : location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
      || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return null;
    const label = String(location?.label ?? '').replace(/\s*예시\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      coordinates: [...coordinates],
      source: 'demo',
      label: label || '차량 기준 위치',
    };
  }
  const truck = data?.truck;
  if (!row?.vehicle.live || row.vehicle.id !== data?.vehicle?.id ||
      !Number.isFinite(truck?.lng) || !Number.isFinite(truck?.lat) ||
      Math.abs(truck.lng) > 180 || Math.abs(truck.lat) > 90) return null;
  return { coordinates: [truck.lng, truck.lat], source: 'simulation', label: '현재 위치 (시뮬레이션)' };
}
