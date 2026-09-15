import { scenarioGroups } from './scenario-guide.mjs';

const stages = scenarioGroups.flatMap(group => group.scenarios);
const times = ['05:45', '05:50', '06:20', '06:30', '06:50', '06:54'];
const messages = [
  '주문 접수와 결제가 완료되었습니다.',
  '출고를 위해 상품을 준비하고 있습니다.',
  '배송 차량에 상차할 준비가 완료되었습니다.',
  '주문하신 상품이 출발했습니다.',
  '기사님이 매장에 도착했습니다. 상품을 전달하고 있습니다.',
  '상품 전달을 완료했습니다.',
];
const validCoordinates = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 85;

export function randomCustomerPosition(home, random = Math.random) {
  if (!validCoordinates(home)) return null;
  const angle = random() * Math.PI * 2;
  const distance = 0.004 + random() * 0.008;
  const lng = home[0] + Math.cos(angle) * distance / Math.cos(home[1] * Math.PI / 180);
  const lat = home[1] + Math.sin(angle) * distance;
  return [((lng + 540) % 360) - 180, lat];
}

// Customer-only previews stay in this page; source orders and server commands are untouched.
export function createCustomerScenarios({ random = Math.random } = {}) {
  const runId = crypto.randomUUID();
  let date;
  let sequence = 0;
  const previews = new Map();
  function entry(delivery) {
    let item = previews.get(delivery.id);
    const coordinatesKey = JSON.stringify(delivery.coordinates ?? null);
    if (!item || item.coordinatesKey !== coordinatesKey) {
      item = { coordinatesKey, scenario: null, position: randomCustomerPosition(delivery.coordinates, random), notices: [] };
      previews.set(delivery.id, item);
    }
    return item;
  }

  function view(state, deliveries, selectedId) {
    if (!state?.sourceData) return state;
    if (date !== state.sourceData.date) { date = state.sourceData.date; previews.clear(); }
    if (state.dispatch?.readOnly) return state;
    const selected = deliveries.find(stop => stop.id === selectedId);
    const item = selected ? entry(selected) : null;
    const index = stages.findIndex(stage => stage.id === item?.scenario);
    const visible = deliveries.map(stop => {
      if (stop.id !== selected?.id) return stop;
      const scenario = item.scenario;
      const truck = (scenario ? scenario === 'completed' : stop.status === 'done') ? null
        : scenario === 'arrived' || (!scenario && stop.arrivedAt)
          ? (validCoordinates(stop.coordinates) ? [...stop.coordinates] : null) : item.position;
      const preview = { ...stop, customerDemo: { scenario, truck } };
      if (index < 0) return preview;
      return { ...preview, dispatchPending: false,
        status: scenario === 'completed' ? 'done' : ['shipping', 'arrived'].includes(scenario) ? 'current' : 'pending',
        customerStatus: { key: scenario, label: stages[index].label },
        arrivedAt: index >= 4 ? times[4] : null,
        completedAt: index === 5 ? times[5] : null,
        customerWindowText: '06:20 ~ 07:20',
        etaSource: 'customer-demo',
        notices: [...(stop.notices || []), ...item.notices],
        timeline: stages.map((stage, at) => ({ label: stage.label, state: at <= index ? 'done' : 'pending', time: at <= index ? times[at] : null })),
      };
    });
    return { ...state, customerDemo: { active: index >= 0 },
      deliveries: visible, fleetDeliveries: visible, customerStopId: selected?.id ?? null,
      scenarioPreset: item?.scenario ?? null, scenarioStopId: selected?.id ?? null,
      simClock: index >= 0 ? times[index] : state.simClock,
    };
  }

  function command(state, deliveries, type, { stopId, scenario } = {}) {
    if (!state?.sourceData || state.dispatch?.readOnly) return false;
    // Also synchronize the date when a command follows a date change.
    view(state, deliveries, stopId);
    const delivery = deliveries.find(stop => stop.id === stopId);
    if (!delivery) return false;
    const item = entry(delivery);
    if (type === 'randomize_customer_position') {
      if (!validCoordinates(delivery.coordinates) || ['arrived', 'completed'].includes(item.scenario)
        || (!item.scenario && (delivery.arrivedAt || delivery.status === 'done'))) return false;
      item.position = randomCustomerPosition(delivery.coordinates, random);
      return true;
    }
    if (type === 'reset_customer_demo') { previews.delete(stopId); return true; }
    const index = stages.findIndex(stage => stage.id === scenario);
    if (type !== 'set_scenario' || index < 0 || item.scenario === scenario) return false;
    item.scenario = scenario;
    item.notices.push({ id: `customer-demo:${runId}:${stopId}:${++sequence}`, kind: scenario,
      time: times[index], title: stages[index].label, body: `${messages[index]} (고객 시연)` });
    item.notices = item.notices.slice(-50);
    return true;
  }
  return { view, command };
}
