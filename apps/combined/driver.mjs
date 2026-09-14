import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { driverTipDelivery, driverViewModel } from './driver-view-model.mjs';

const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);
let latest;
let connected = false;
let currentId = null;
let selectedTipId = null;
let pendingTip = null;
let pendingTipTimer = null;
const drafts = new Map();

const shell = mountDemoShell({ viewer: 'driver', onSend: (type, extra) => simulation.send(type, extra) });
shell.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    latest = adaptSimulation(raw);
    if (latest.truck && Number.isFinite(raw.truck?.remainingM)) latest.truck.remainingM = raw.truck.remainingM;
    render();
  },
  onStatus(value, message) {
    connected = value;
    if (!value && pendingTip) {
      clearTimeout(pendingTipTimer);
      pendingTip = null;
      setTipStatus('연결이 끊겨 저장 여부를 확인할 수 없습니다. 다시 시도해 주세요.', 'error');
    }
    byId('driver-connection').hidden = value;
    byId('driver-connection').textContent = message;
    byId('driver-workspace').hidden = !latest;
    shell.update(latest, value);
    if (latest) render();
  },
  onError: message => {
    if (pendingTip) {
      pendingTip = null;
      setTipStatus('저장하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.', 'error');
    }
    shell.showError(message);
  },
});

function fleetDeliveries() {
  return latest?.fleetDeliveries?.length ? latest.fleetDeliveries : latest?.deliveries || [];
}

function setTipStatus(message, tone = '') {
  byId('driver-tip-status').textContent = message;
  byId('driver-tip-status').dataset.tone = tone;
}

function renderTipEditor() {
  const deliveries = fleetDeliveries();
  if (!selectedTipId || !deliveries.some(delivery => delivery.id === selectedTipId)) selectedTipId = new URLSearchParams(location.search).get('id') || currentId || latest.customerStopId || deliveries[0]?.id;
  const select = byId('driver-tip-stop');
  const optionKey = deliveries.map(delivery => delivery.id).join('|');
  if (select.dataset.key !== optionKey) {
    select.innerHTML = deliveries.map(delivery => `<option value="${escapeHtml(delivery.id)}">${escapeHtml(delivery.vehicle?.plate ? `${delivery.vehicle.plate} · ` : '')}${escapeHtml(delivery.name)} · ${escapeHtml(delivery.boxes ?? '—')}박스</option>`).join('');
    select.dataset.key = optionKey;
  }
  select.value = selectedTipId || '';
  const delivery = driverTipDelivery(latest, selectedTipId);
  const textarea = byId('driver-tip-body');
  const savedBody = delivery?.tip?.body || '';
  if (!drafts.has(selectedTipId)) drafts.set(selectedTipId, savedBody);
  if (document.activeElement !== textarea) textarea.value = drafts.get(selectedTipId) ?? savedBody;
  byId('driver-tip-count').textContent = `${textarea.value.length}/500`;
  byId('driver-tip-author').textContent = delivery?.tip ? `${delivery.tip.author || '배송원'} · ${delivery.tip.updatedAt || '시각 미확인'}` : '작성 기록 없음';
  if (pendingTip && pendingTip.stopId === selectedTipId && delivery?.tip?.body === pendingTip.body) {
    drafts.set(selectedTipId, delivery.tip.body);
    clearTimeout(pendingTipTimer);
    pendingTip = null;
    setTipStatus('배송 팁을 저장했습니다.', 'success');
  }
  byId('driver-tip-save').disabled = !connected || !delivery || !textarea.value.trim() || Boolean(pendingTip);
}

function render() {
  if (!selectedTipId) selectedTipId = new URLSearchParams(location.search).get('id') || latest.customerStopId;
  const view = driverViewModel(latest, connected, selectedTipId);
  currentId = view.current?.id || null;
  shell.select(view.selected?.id || currentId || latest.customerStopId);
  byId('driver-clock').textContent = latest.simClock || '--:--';
  byId('driver-name').textContent = view.vehicle?.driver ? `${view.vehicle.driver} 배송원` : '배송원 미확인';
  byId('driver-vehicle').textContent = [view.vehicle?.plate, view.vehicle?.region].filter(Boolean).join(' · ') || '차량 미확인';
  byId('driver-status').textContent = view.status;
  byId('driver-status').dataset.tone = view.statusTone;
  byId('driver-current-title').textContent = view.destination;
  byId('driver-address').textContent = view.address;
  byId('driver-distance').textContent = view.distance;
  byId('driver-boxes').textContent = view.boxes;
  byId('driver-progress').textContent = view.progress;
  byId('driver-complete').disabled = !view.canComplete;
  byId('driver-action-note').textContent = view.actionNote;
  byId('driver-done').textContent = view.progress;
  byId('driver-left').textContent = String(view.remainingBoxes);
  byId('driver-finish').textContent = view.finishEta;
  byId('driver-manage-link').href = `/combined/${view.selected?.id ? `?id=${encodeURIComponent(view.selected.id)}` : ''}#/control/manage`;
  byId('driver-route').innerHTML = view.deliveries.map(stop => `<li data-status="${escapeHtml(stop.status)}"><span class="driver-route-number">${stop.status === 'done' ? '✓' : stop.sequence}</span><span class="driver-route-copy"><strong>${escapeHtml(stop.name)}</strong><span>${escapeHtml(stop.address)} · ${escapeHtml(stop.boxes ?? '미확인')}박스</span></span><span class="driver-route-state">${stop.status === 'done' && stop.completedAt ? `${escapeHtml(stop.completedAt)} 완료` : escapeHtml(statusLabels[stop.status] || '미확인')}</span></li>`).join('');
  renderTipEditor();
}

byId('driver-complete').addEventListener('click', () => {
  if (!currentId || !driverViewModel(latest, connected, selectedTipId).canComplete) return;
  simulation.send('complete_stop', { stopId: currentId });
});

byId('driver-tip-stop').addEventListener('change', event => {
  selectedTipId = event.target.value;
  const url = new URL(location.href);
  url.searchParams.set('id', selectedTipId);
  history.replaceState(null, '', url);
  shell.select(selectedTipId);
  setTipStatus('');
  render();
});
byId('driver-tip-body').addEventListener('input', event => {
  drafts.set(selectedTipId, event.target.value);
  byId('driver-tip-count').textContent = `${event.target.value.length}/500`;
  byId('driver-tip-save').disabled = !connected || !event.target.value.trim() || Boolean(pendingTip);
  setTipStatus('');
});
byId('driver-tip-save').addEventListener('click', () => {
  const delivery = driverTipDelivery(latest, selectedTipId);
  if (!connected || !delivery || pendingTip) return;
  const body = byId('driver-tip-body').value.trim();
  if (!body) return;
  pendingTip = { stopId: delivery.id, body };
  byId('driver-tip-save').disabled = true;
  setTipStatus('저장 중입니다.');
  simulation.send('set_delivery_tip', pendingTip);
  clearTimeout(pendingTipTimer);
  pendingTipTimer = setTimeout(() => {
    if (!pendingTip) return;
    pendingTip = null;
    setTipStatus('서버 응답을 확인하지 못했습니다. 다시 시도해 주세요.', 'error');
    renderTipEditor();
  }, 5000);
});
