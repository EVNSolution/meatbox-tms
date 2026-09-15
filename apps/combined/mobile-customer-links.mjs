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
  onState(raw, context) {
    adapted = adaptSimulation(raw);
    rawSnapshot = raw;
    snapshotContext = context;
    connected = true;
    render();
  },
  onStatus(value, message) {
    connected = value;
    const notice = document.getElementById('customer-connection');
    notice.hidden = connected;
    notice.textContent = message;
    shell.update(displayed || adapted, connected);
  },
  onError: message => shell.showError(message),
});
