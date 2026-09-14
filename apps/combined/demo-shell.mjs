import { deliveryLinks } from './delivery-review.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';

export function mountDemoShell({ viewer, onSend }) {
  const initialLinks = deliveryLinks(new URLSearchParams(location.search).get('id'));
  document.body.dataset.viewer = viewer;
  document.getElementById('demo-header').innerHTML = `<a class="demo-brand" href="/">미트박스 <span>TMS</span></a><strong>배송 시연</strong><nav class="viewer-switch" aria-label="뷰어 선택"><a data-viewer="operator" href="${initialLinks.operator}">운영 뷰어</a><a data-viewer="customer" href="${initialLinks.mobile}">고객 뷰어</a></nav><a class="demo-entry-link" href="/">시연 안내</a>`;
  const navigation = document.getElementById('demo-navigation');
  if (navigation) navigation.innerHTML = `<nav class="operator-pages" aria-label="운영 업무"><a href="#/deliveries" data-page-link="deliveries">배송 목록</a><a href="#/manage" data-page-link="manage">배송 관리</a><a href="#/control" data-page-link="control">배송 관제</a></nav>`;
  document.querySelector(`#demo-header [data-viewer="${viewer}"]`).setAttribute('aria-current', 'page');
  const guide = mountScenarioTools({ onSend });
  let lastId;
  return {
    update(state, connected) { guide.update(state, connected); },
    showError(message) { guide.showError(message); },
    select(id) {
      if (id === lastId) return;
      lastId = id;
      guide.select(id);
      const links = deliveryLinks(id);
      document.querySelector('#demo-header [data-viewer="operator"]').href = links.operator;
      document.querySelector('#demo-header [data-viewer="customer"]').href = links.mobile;
    },
  };
}
