const DAY_MINUTES = 24 * 60;
const DEPARTURE_MINUTES = 6 * 60 + 30;
const FIRST_TRAVEL_MINUTES = 20;
const SERVICE_MINUTES = 4;
const KST_OFFSET_MS = 9 * 60 * 60000;

const validDate = value => {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
};

const validCoordinates = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

function formatMinute(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  const day = Math.floor(rounded / DAY_MINUTES);
  const minute = ((rounded % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const prefix = day === 1 ? '다음날 ' : day > 1 ? `+${day}일 ` : '';
  return `${prefix}${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function clockMinute(value, dayStart, cursor = 0) {
  if (Number.isFinite(value)) {
    const offset = (value - dayStart) / 60000;
    if (offset >= -DAY_MINUTES && offset < DAY_MINUTES * 4) return offset;
    const korea = new Date(value + KST_OFFSET_MS);
    value = `${String(korea.getUTCHours()).padStart(2, '0')}:${String(korea.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return clockMinute(value.getTime(), dayStart, cursor);
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(?:(?:\+(\d+)일|다음날)\s*)?(\d{2}):(\d{2})$/);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : clockMinute(parsed, dayStart, cursor);
  }
  const hour = Number(match[2]), minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const explicitDay = text.startsWith('다음날') ? 1 : Number(match[1] || 0);
  let result = explicitDay * DAY_MINUTES + hour * 60 + minute;
  if (!explicitDay) {
    result += Math.floor(Math.max(0, cursor) / DAY_MINUTES) * DAY_MINUTES;
    if (result < cursor - DAY_MINUTES / 2) result += DAY_MINUTES;
  }
  return result;
}

function eventMinute(events, action, stopId, vehicleId, dayStart, cursor) {
  const matches = events.filter(event => event?.action === action
    && (!stopId || event.stopId === stopId)
    && (!vehicleId || !event.vehicleId || event.vehicleId === vehicleId));
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const minute = clockMinute(matches[index].ts ?? matches[index].time, dayStart, cursor);
    if (minute != null) return minute;
  }
  return null;
}

function actualMinute(stop, action, events, vehicleId, dayStart, cursor) {
  const field = action === 'completed' ? stop.completedAt : stop.arrivedAt;
  return clockMinute(field, dayStart, cursor)
    ?? eventMinute(events, action, stop.id, vehicleId, dayStart, cursor);
}

function distanceKm(left, right) {
  const radians = degrees => degrees * Math.PI / 180;
  const lat1 = radians(left[1]), lat2 = radians(right[1]);
  const dLat = lat2 - lat1, dLng = radians(right[0] - left[0]);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function travelMinutes(previous, current, first) {
  if (!validCoordinates(current)) return null;
  if (first) return FIRST_TRAVEL_MINUTES;
  if (!validCoordinates(previous)) return null;
  return distanceKm(previous, current) * 1.3 / 30 * 60;
}

function fixedEstimateMinute(stop, dayStart, cursor) {
  if (stop.etaSource === 'operating-plan') return null;
  return clockMinute(stop.officialEta?.time ?? stop.officialEta?.preciseTimeText
    ?? stop.preciseTimeText ?? stop.calculatedEta, dayStart, cursor);
}

function withoutGeneratedEstimate(stop) {
  const copy = { ...stop };
  if (copy.etaSource !== 'operating-plan') return copy;
  const generated = Array.isArray(copy.operatingPlanFields)
    ? copy.operatingPlanFields : ['calculatedEta', 'preciseTimeText', 'etaSource'];
  for (const key of generated) delete copy[key];
  delete copy.operatingPlanFields;
  return copy;
}

function conditionDetails(stop) {
  const provided = (Array.isArray(stop?.transportConditions) ? stop.transportConditions : [])
    .map(item => typeof item === 'string' ? item : item?.label).map(item => String(item ?? '').trim()).filter(Boolean);
  if (provided.length) return { text: [...new Set(provided)].join(' / '), source: 'provided' };
  const itemText = (Array.isArray(stop?.items) ? stop.items : [])
    .flatMap(item => [item?.name, item?.opt, item?.description]).join(' ');
  const temperatures = ['냉장', '냉동'].filter(label => itemText.includes(label)).map(label => `${label} 운송`);
  return temperatures.length
    ? { text: temperatures.join(' / '), source: 'item-data' }
    : { text: '보냉 운송 / 포장 상태 확인', source: 'operating-default' };
}

export function sourceViewerPlan({ date, deliveries, events = [], vehicleId } = {}) {
  if (!Array.isArray(deliveries)) return { deliveries: [], departureText: null, finishText: null, timing: null };
  if (!validDate(date)) return { deliveries, departureText: null, finishText: null, timing: null };
  const dayStart = Date.parse(`${date}T00:00:00+09:00`);
  const input = vehicleId ? deliveries.filter(stop => stop?.vehicleId === vehicleId) : deliveries;
  const allowed = new Set(input.map(stop => stop?.id));
  const sourceEvents = Array.isArray(events) ? events : [];
  let cursor = DEPARTURE_MINUTES;
  let previousCoordinates = null;
  let first = true;
  let unknownStops = 0;
  let expectedCompletion = DEPARTURE_MINUTES;
  const actualCompletions = [];

  const planned = deliveries.map(original => {
    if (!allowed.has(original?.id)) return original;
    const stop = withoutGeneratedEstimate(original);
    const condition = conditionDetails(stop);
    if (condition.source === 'operating-default' && !stop.transportConditionSource) stop.transportConditionSource = condition.source;
    if (stop.status === 'skipped') return stop;
    const travel = travelMinutes(previousCoordinates, stop.coordinates, first);
    let arrival = cursor == null || travel == null ? null : cursor + travel;
    const fixed = fixedEstimateMinute(stop, dayStart, cursor ?? DEPARTURE_MINUTES);
    if (fixed != null) arrival = fixed;
    const completed = actualMinute(stop, 'completed', sourceEvents, vehicleId, dayStart, arrival ?? cursor ?? 0);
    const arrived = completed == null
      ? actualMinute(stop, 'arrived', sourceEvents, vehicleId, dayStart, arrival ?? cursor ?? 0) : null;

    if (fixed == null && arrival != null && completed == null && arrived == null) {
      const text = formatMinute(arrival);
      const generated = [];
      const set = (key, value) => {
        if (stop[key] != null) return;
        stop[key] = value;
        generated.push(key);
      };
      set('calculatedEta', text);
      set('preciseTimeText', text);
      set('customerWindowStart', formatMinute(arrival - 30));
      set('customerWindowEnd', formatMinute(arrival + 30));
      set('customerWindowText', `${formatMinute(arrival - 30)} ~ ${formatMinute(arrival + 30)}`);
      set('etaSource', 'operating-plan');
      if (generated.length) stop.operatingPlanFields = generated;
    }

    if (completed != null) { cursor = completed; actualCompletions.push(completed); }
    else if (arrived != null) cursor = arrived + SERVICE_MINUTES;
    else cursor = arrival == null ? null : arrival + SERVICE_MINUTES;
    if (cursor == null) unknownStops += 1;
    else expectedCompletion = cursor;
    previousCoordinates = validCoordinates(stop.coordinates) ? stop.coordinates : null;
    first = false;
    return stop;
  });

  const heldStops = input.filter(stop => stop?.status === 'skipped').length;
  const allDone = input.length > 0 && input.every(stop => stop?.status === 'done');
  const actualCompletion = actualCompletions.length === input.length ? Math.max(...actualCompletions) : null;
  const completionMinute = !input.length ? null : allDone ? actualCompletion : heldStops || unknownStops ? null : expectedCompletion;
  const finishText = !input.length ? '배차 없음' : heldStops ? '보류 배송 확인'
    : allDone ? (actualCompletion == null ? '완료 시각 미수신' : formatMinute(actualCompletion))
      : completionMinute == null ? '완료 예상 미확인' : formatMinute(completionMinute);
  const actualDeparture = eventMinute(sourceEvents, 'shipping', null, vehicleId, dayStart, DEPARTURE_MINUTES);
  return {
    deliveries: planned,
    departureText: formatMinute(DEPARTURE_MINUTES),
    finishText,
    timing: {
      source: 'operating-plan',
      departureMs: dayStart + DEPARTURE_MINUTES * 60000,
      completionMs: completionMinute == null ? null : dayStart + completionMinute * 60000,
      durationMinutes: completionMinute == null ? null : Math.round(completionMinute - DEPARTURE_MINUTES),
      heldStops,
      unknownStops,
      actualDepartureText: actualDeparture == null ? null : formatMinute(actualDeparture),
    },
  };
}

export function transportConditionText(stop) {
  return conditionDetails(stop).text;
}
