import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';
import { mountCustomerRenderer } from './customer-renderer.mjs';

let adapted;
let connected = false;
const shell = mountDemoShell({ viewer: 'customer', onSend: (type, extra) => simulation.send(type, extra) });
shell.update(null, false);
const renderer = mountCustomerRenderer({ onSelect: id => shell.select(id) });
const simulation = connectSimulation({
  onState(raw, context) {
    adapted = adaptSimulation(raw);
    renderer.update(adapted, raw, context);
    shell.update(adapted, true);
  },
  onStatus(value, message) {
    connected = value;
    const notice = document.getElementById('customer-connection');
    notice.hidden = connected;
    notice.textContent = message;
    shell.update(adapted, connected);
  },
  onError: message => shell.showError(message),
});
