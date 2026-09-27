import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { customerViewerDeliveries, mountCustomerRenderer } from './customer-renderer.mjs';
import { createCustomerScenarios } from './customer-scenarios.mjs';
import { sourceVehicleContext } from './source-context.mjs';

let adapted;
let rawSnapshot, snapshotContext, displayed;
let selectedId = new URLSearchParams(location.search).get('id');
try { selectedId ||= localStorage.getItem('mb-account'); } catch {}
let connected = false;
let emptyDate = false;
const scenarios = createCustomerScenarios();
function render() {
  if (!adapted) return;
  const source = sourceVehicleContext(adapted, selectedId);
  const preview = scenarios.view(source, customerViewerDeliveries(source), selectedId);
  displayed = renderer.update(preview, rawSnapshot, snapshotContext) || preview;
  shell.update(displayed, connected);
}
const shell = mountDemoShell({ viewer: 'customer', onSelect: id => renderer.select(id), onSend: (type, extra) => {
  if (adapted?.sourceData) {
    if (!connected) return shell.showError('연결이 복구된 뒤 진행해 주세요.');
    if (scenarios.command(adapted, customerViewerDeliveries(adapted), type, extra)) render();
    else shell.showError('선택한 배송의 시연 상태를 확인해 주세요.');
    return;
  }
  simulation.send(type, extra);
} });
shell.update(null, false);
const renderer = mountCustomerRenderer({ onSelect: id => {
  const changed = selectedId !== id;
  selectedId = id;
  shell.select(id);
  if (changed) queueMicrotask(render);
} });
const simulation = connectSimulation({
  onDateContext(context) {
    emptyDate = context.empty;
    adapted = null; rawSnapshot = null; displayed = null;
    shell.setDate(context.date);
    document.getElementById('customer-viewer-summary').textContent = context.empty ? `${context.date || '선택한 날짜'}에 배송 자료가 없습니다.` : '배송 정보를 불러오고 있습니다.';
    if (context.empty) document.getElementById('account-picker').hidden = true;
    document.querySelector('.mobile-shell').hidden = true;
  },
  onState(raw, context) {
    adapted = adaptSimulation(raw);
    rawSnapshot = raw;
    snapshotContext = context;
    connected = true;
    emptyDate = false;
    document.querySelector('.mobile-shell').hidden = false;
    render();
  },
  onStatus(value, message) {
    connected = value;
    const notice = document.getElementById('customer-connection');
    notice.hidden = connected && !emptyDate;
    notice.textContent = emptyDate ? '선택한 날짜에 배송 자료가 없습니다. 운영자 화면에서 다른 날짜를 조회해 주세요.' : message;
    shell.update(displayed || adapted, connected);
  },
  onError: message => shell.showError(message),
});
