import { deliveryLinks } from './delivery-review.mjs';
import { adaptSimulation } from './simulation-adapter.mjs';
import { mountDemoShell } from './demo-shell.mjs';
import { connectSimulation } from './simulation-client.mjs';

let renderCustomer;
let latest;
let adapted;
let connected = false;
const shell = mountDemoShell({ viewer: 'customer', onSend: (type, extra) => simulation.send(type, extra) });
shell.update(null, false);
const simulation = connectSimulation({
  onState(raw) {
    latest = raw;
    adapted = adaptSimulation(raw);
    renderCustomer?.(raw);
    syncOperatorLinks();
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

// Reuse the original customer renderer and map helpers with the same page connection as the guide.
window.MB.connect = callback => { renderCustomer = callback; if (latest) callback(latest); };
window.MB.send = simulation.send;

let lastId;
function syncOperatorLinks() {
  const id = new URLSearchParams(location.search).get('id');
  if (id === lastId) return;
  lastId = id;
  shell.select(id);
  for (const link of document.querySelectorAll('[data-operator-link]')) link.href = deliveryLinks(id).operator;
}
new MutationObserver(syncOperatorLinks).observe(document.getElementById('account-name'), { childList: true });
syncOperatorLinks();
try { await import('/scenario/customer.js'); }
catch { shell.showError('고객 화면을 불러오지 못했습니다. 새로고침해 주세요.'); }
