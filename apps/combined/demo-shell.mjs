import { deliveryLinks } from './delivery-review.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';

export function mountDemoShell({ viewer, onSend }) {
  document.getElementById('demo-header').innerHTML = `<a class="demo-brand" href="/">미트박스 <span>TMS</span></a><strong>배송 시연</strong><a class="demo-entry-link" href="/">시연 안내</a>`;
  const initialLinks = deliveryLinks(new URLSearchParams(location.search).get('id'));
  document.getElementById('demo-navigation').innerHTML = `<nav class="viewer-tabs" aria-label="시연 뷰어"><a data-viewer="operator" href="${initialLinks.operator}">운영<br>뷰어</a><a data-viewer="customer" href="${initialLinks.mobile}">고객<br>뷰어</a></nav>`;
  document.querySelector(`[data-viewer="${viewer}"]`).setAttribute('aria-current', 'page');
  const guide = mountScenarioTools({ onSend, container: document.getElementById('demo-guide') });
  let lastId;
  return {
    update(state, connected) { guide.update(state, connected); },
    showError(message) { guide.showError(message); },
    select(id) {
      if (id === lastId) return;
      lastId = id;
      const links = deliveryLinks(id);
      document.querySelector('[data-viewer="operator"]').href = links.operator;
      document.querySelector('[data-viewer="customer"]').href = links.mobile;
    },
  };
}
