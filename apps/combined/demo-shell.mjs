import { deliveryLinks } from './delivery-review.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';

const operatorStorageKey = 'meatbox.operator.page';
const operatorHashStorageKey = 'meatbox.operator.hash';
const operatorPages = new Set(['orders', 'deliveries', 'control']);

function lastOperatorPage() {
  try {
    const page = sessionStorage.getItem(operatorStorageKey);
    return operatorPages.has(page) ? page : 'control';
  } catch { return 'control'; }
}

const operatorLink = (base, page) => base.replace(/#\/control$/, `#/${page}`);

function lastOperatorLink(base) {
  try {
    const hash = sessionStorage.getItem(operatorHashStorageKey);
    if (/^#\/(?:orders|deliveries|control(?:\/manage)?)$/.test(hash || '')) return base.replace(/#\/control$/, hash);
  } catch {}
  return operatorLink(base, lastOperatorPage());
}

export function mountDemoShell({ viewer, onSend, onSelect }) {
  let currentLinks = deliveryLinks(new URLSearchParams(location.search).get('id'));
  document.body.dataset.viewer = viewer;
  document.getElementById('demo-header').innerHTML = `<a class="demo-brand" href="/combined/"><img src="./assets/meatbox-logo.svg" width="126" height="30" alt="미트박스"><span>TMS</span></a><nav class="viewer-switch" aria-label="뷰어 선택"><a data-viewer="operator" href="${lastOperatorLink(currentLinks.operator)}">운영 뷰어</a><a data-viewer="customer" href="${currentLinks.customer}">고객 뷰어</a><a data-viewer="driver" href="${currentLinks.driver}">배송원 뷰어</a></nav>`;
  const navigation = document.getElementById('demo-navigation');
  if (navigation) navigation.innerHTML = `<nav class="operator-pages" aria-label="운영 업무"><span class="operator-axis">운영 메뉴</span><a href="${operatorLink(currentLinks.operator, 'orders')}" data-page-link="orders">배차 관리</a><a href="${operatorLink(currentLinks.operator, 'control')}" data-page-link="control">배송 관제</a><a href="${operatorLink(currentLinks.operator, 'deliveries')}" data-page-link="deliveries">자원 관리</a></nav>`;
  document.querySelector(`#demo-header [data-viewer="${viewer}"]`).setAttribute('aria-current', 'page');
  function syncOperatorHash() {
    if (viewer !== 'operator' || !/^#\/(?:orders|deliveries|control(?:\/manage)?)$/.test(location.hash)) return;
    try {
      sessionStorage.setItem(operatorHashStorageKey, location.hash);
      sessionStorage.setItem(operatorStorageKey, location.hash.match(/^#\/(orders|deliveries|control)/)[1]);
    } catch {}
    document.querySelector('#demo-header [data-viewer="operator"]').href = currentLinks.operator.replace(/#\/control$/, location.hash);
  }
  if (viewer === 'operator') {
    window.addEventListener('hashchange', syncOperatorHash);
    document.querySelector('#demo-header [data-viewer="operator"]').addEventListener('click', syncOperatorHash);
    document.querySelectorAll('#demo-header [data-viewer="customer"], #demo-header [data-viewer="driver"]').forEach(link => link.addEventListener('click', syncOperatorHash));
    syncOperatorHash();
  }
  const guide = mountScenarioTools({ onSend, onSelect });
  let lastId;
  return {
    update(state, connected) { guide.update(state, connected); },
    showError(message) { guide.showError(message); },
    select(id) {
      if (id === lastId) return;
      lastId = id;
      guide.select(id);
      currentLinks = deliveryLinks(id);
      document.querySelector('#demo-header [data-viewer="operator"]').href = viewer === 'operator' && /^#\/(?:orders|deliveries|control(?:\/manage)?)$/.test(location.hash) ? currentLinks.operator.replace(/#\/control$/, location.hash) : lastOperatorLink(currentLinks.operator);
      document.querySelector('#demo-header [data-viewer="customer"]').href = currentLinks.customer;
      document.querySelector('#demo-header [data-viewer="driver"]').href = currentLinks.driver;
      navigation?.querySelectorAll('[data-page-link]').forEach(link => { link.href = operatorLink(currentLinks.operator, link.dataset.pageLink); });
    },
  };
}
