import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { driverViewModel } from './driver-view-model.mjs';

const statusLabels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);
let latest;
let connected = false;
let currentId = null;

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
    byId('driver-connection').hidden = value;
    byId('driver-connection').textContent = message;
    byId('driver-workspace').hidden = !latest;
    shell.update(latest, value);
    if (latest) render();
  },
  onError: message => shell.showError(message),
});

function render() {
  const view = driverViewModel(latest, connected);
  currentId = view.current?.id || null;
  const selectedId = new URLSearchParams(location.search).get('id') || currentId || latest.customerStopId;
  shell.select(selectedId);
  byId('driver-clock').textContent = latest.simClock || '--:--';
  byId('driver-name').textContent = latest.vehicle?.driver ? `${latest.vehicle.driver} 배송원` : '배송원 미확인';
  byId('driver-vehicle').textContent = [latest.vehicle?.plate, latest.vehicle?.region].filter(Boolean).join(' · ') || '차량 미확인';
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
  byId('driver-manage-link').href = `/combined/${selectedId ? `?id=${encodeURIComponent(selectedId)}` : ''}#/control/manage`;
  byId('driver-route').innerHTML = latest.deliveries.map(stop => `<li data-status="${escapeHtml(stop.status)}"><span class="driver-route-number">${stop.status === 'done' ? '✓' : stop.sequence}</span><span class="driver-route-copy"><strong>${escapeHtml(stop.name)}</strong><span>${escapeHtml(stop.address)} · ${escapeHtml(stop.boxes ?? '미확인')}박스</span></span><span class="driver-route-state">${stop.status === 'done' && stop.completedAt ? `${escapeHtml(stop.completedAt)} 완료` : escapeHtml(statusLabels[stop.status] || '미확인')}</span></li>`).join('');
}

byId('driver-complete').addEventListener('click', () => {
  if (!currentId || !driverViewModel(latest, connected).canComplete) return;
  simulation.send('complete_stop', { stopId: currentId });
});
