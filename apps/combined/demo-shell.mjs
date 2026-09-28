import { deliveryLinks } from './delivery-review.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';
import { sourceVehicleContext } from './source-context.mjs';

const operatorLink = (base, page) => base.replace(/#\/control$/, `#/${page}`);

export function mountDemoShell({ viewer, onSend, onSelect }) {
  let currentDate = new URLSearchParams(location.search).get('date');
  let latest;
  let lastId;
  let isConnected = false;
  document.body.dataset.viewer = viewer;
  document.getElementById('demo-header').innerHTML = '<a class="demo-brand" href="/combined/"><img src="./assets/meatbox-logo.svg" width="126" height="30" alt="미트박스"><span>TMS</span></a>';
  const navigation = document.getElementById('demo-navigation');
  if (navigation && viewer === 'operator') navigation.innerHTML = '<nav class="operator-pages" aria-label="운영 업무"><span class="operator-axis">운영 메뉴</span><a data-page-link="orders">배차 관리</a><a data-page-link="control">배송 관제</a><a data-page-link="deliveries">자원 관리</a></nav>';
  const guide = mountScenarioTools({ onSend, onSelect });
  function syncLinks() {
    const links = deliveryLinks(lastId, currentDate);
    navigation?.querySelectorAll('[data-page-link]').forEach(link => { link.href = operatorLink(links.operator, link.dataset.pageLink); });
  }
  syncLinks();
  return {
    setDate(date) { currentDate = date; syncLinks(); },
    update(state, connected) {
      latest = state || null;
      isConnected = connected;
      guide.update(sourceVehicleContext(latest, lastId), connected);
      if (latest?.sourceData?.date && latest.sourceData.date !== currentDate) {
        currentDate = latest.sourceData.date;
        syncLinks();
      }
    },
    showError(message) { guide.showError(message); },
    select(id) {
      if (id === lastId) return;
      lastId = id;
      guide.select(id);
      guide.update(sourceVehicleContext(latest, id), isConnected);
      syncLinks();
    },
  };
}
