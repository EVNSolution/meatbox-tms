import { createStateReceiver } from './state-frames.mjs';
import { connectSourceOperations } from './source-client.mjs';
import { bundleDeliveries } from './delivery-bundles.mjs';

export function expandSourceCommand(type, extra = {}, state) {
  if (type !== 'set_route_order' || !state?.sourceData || !Array.isArray(state.fleetDeliveries)) return extra;
  const ids = Array.isArray(extra.expectedOrder) ? extra.expectedOrder : extra.order;
  const hinted = new Set(Array.isArray(ids) ? ids : []);
  const vehicleId = extra.vehicleId ?? state.fleetDeliveries.find(order => hinted.has(order.id))?.vehicleId;
  const route = state.fleetDeliveries.filter(order => order.vehicleId === vehicleId);
  if (!route.length) return extra;
  const routeIds = route.map(order => order.id);
  const bundles = bundleDeliveries(route);
  const compactOrder = bundles.map(bundle => bundle.id);
  const compactStatuses = bundles.map(bundle => bundle.status);
  const byId = new Map(bundles.flatMap(bundle => bundle.orderIds.map(id => [id, bundle])));
  const alreadyRaw = value => Array.isArray(value) && value.length === routeIds.length
    && value.every(id => routeIds.includes(id)) && new Set(value).size === routeIds.length;
  const expand = value => {
    if (!Array.isArray(value) || alreadyRaw(value)) return value;
    const seen = new Set();
    return value.flatMap(id => {
      const bundle = byId.get(id);
      if (!bundle || seen.has(bundle.id)) return bundle ? [] : [id];
      seen.add(bundle.id);
      return bundle.orderIds;
    });
  };
  const compactBaseline = Array.isArray(extra.expectedOrder) && Array.isArray(extra.expectedStatuses)
    && extra.expectedOrder.length === compactOrder.length && extra.expectedStatuses.length === compactStatuses.length
    && extra.expectedOrder.every((id, index) => id === compactOrder[index] && extra.expectedStatuses[index] === compactStatuses[index]);
  const expectedOrder = compactBaseline && !alreadyRaw(extra.expectedOrder) ? routeIds : extra.expectedOrder;
  const expectedStatuses = compactBaseline && !alreadyRaw(extra.expectedOrder) ? route.map(order => order.status) : extra.expectedStatuses;
  return { ...extra, order: expand(extra.order), expectedOrder, expectedStatuses };
}

// Both viewers use one connection per page, including the original customer renderer.
export function connectSimulation({ onState, onStatus, onError }) {
  let socket;
  let timer;
  let boot;
  let reconnectAttempt = 0;
  let stopped = false;
  let source = null;
  let sourceState = null;
  let sourceChecked = false;
  const login = () => location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash));

  function reconnect() {
    const delay = Math.min(30_000, 1500 * 2 ** Math.min(reconnectAttempt++, 5));
    timer = setTimeout(connect, delay + Math.floor(Math.random() * 1000));
  }

  async function connect() {
    if (stopped) return;
    onStatus(false, '배송 정보를 불러오고 있습니다.');
    try {
      const response = await fetch('/api/session', { headers: { accept: 'application/json' } });
      if (stopped) return;
      if (response.status === 401) return login();
      if (!response.ok) throw new Error('세션 확인 실패');
      if (!sourceChecked) {
        const available = await fetch('/api/dispatch-data/manifest', { headers: { accept: 'application/json' } });
        if (stopped) return;
        if (available.status === 401) return login();
        if (available.ok) {
          source = connectSourceOperations({ manifest: await available.json(), onState(state, context) {
            sourceState = state; onState(state, context);
          }, onStatus, onError, login });
          return;
        }
        if (available.status !== 404) throw new Error('원본 주문 자료 확인 실패');
        sourceChecked = true;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const receiver = createStateReceiver();
      socket = new WebSocket(`${protocol}//${location.host}/ws/simulation`, 'meatbox-state-v2');
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'error') return onError('요청을 처리하지 못했습니다. 현재 단계를 확인하고 다시 시도해 주세요.');
        if (message.boot) {
          if (boot && boot !== message.boot) return location.reload();
          boot = message.boot;
        }
        if (!['state', 'state_patch'].includes(message.type)) return;
        let state;
        try { state = receiver.receive(message); }
        catch { socket.close(); return; }
        try { onState(state, { boot }); reconnectAttempt = 0; onStatus(true, ''); }
        catch { onStatus(false, '받은 배송 정보를 표시할 수 없습니다.'); socket.close(); }
      });
      socket.addEventListener('close', event => {
        if (stopped) return;
        onStatus(false, '연결이 끊겼습니다. 자동으로 다시 연결합니다.');
        if ([1008, 4401, 4403].includes(event.code) || /auth|login|session/i.test(event.reason)) return login();
        reconnect();
      });
      socket.addEventListener('error', () => socket.close());
    } catch {
      if (stopped) return;
      onStatus(false, '서버에 연결할 수 없습니다. 자동으로 다시 연결합니다.');
      reconnect();
    }
  }
  connect();
  return {
    send(type, extra = {}) {
      if (source) return source.send(type, expandSourceCommand(type, extra, sourceState));
      if (socket?.readyState !== WebSocket.OPEN) { onError('연결이 복구된 뒤 진행해 주세요.'); return; }
      socket.send(JSON.stringify({ type, ...extra }));
    },
    selectDate(date) { return source ? source.selectDate(date) : Promise.resolve(null); },
    close() { stopped = true; clearTimeout(timer); socket?.close(); source?.close(); },
  };
}
