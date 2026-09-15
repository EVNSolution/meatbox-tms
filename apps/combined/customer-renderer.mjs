import { referenceIcon } from './reference-icons.mjs';
import { inboxState, noticeKey, visibleNotices, updateInbox } from './customer-inbox.mjs';
import { customerDemoRoad } from './customer-demo-route.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function customerEtaText(delivery) {
  if (delivery?.status === 'done') return delivery.completedAt ? `${delivery.completedAt} 배송 완료` : '배송 완료';
  if (delivery?.status === 'skipped') return '배송이 보류되었습니다';
  return delivery?.customerWindowText || '도착 예정 시간 계산 중';
}

export function customerNoticeBody(notice, delivery) {
  const body = String(notice?.body ?? '');
  if (!['departure', 'shipping', 'delay'].includes(notice?.kind)) return body;
  // Only legacy single-point ETA notices need a window. Existing ranges and event times are historical facts.
  if ((body.match(/\d{2}:\d{2}/g) || []).length !== 1) return body;
  const precise = delivery?.preciseTimeText;
  const windowText = delivery?.customerWindowText;
  return precise && windowText ? body.replaceAll(precise, windowText) : body;
}

export function nextCustomerPopup(previousIds, notices) {
  return notices.findLast(notice => notice.id && !previousIds.has(notice.id)) ?? null;
}

export function customerPopupState(previousIds, notices) {
  return {
    popup: nextCustomerPopup(previousIds, notices),
    currentIds: new Set(notices.map(notice => notice.id).filter(Boolean)),
  };
}

export function mountCustomerRenderer({ mb, onSelect }) {
  const byId = id => document.getElementById(id);
  let latest;
  let selectedId;
  let routeData;
  let map;
  let homeMarker;
  let truckMarker;
  let popupBaseline = new Set();
  let popupTimer;
  let popupNotice;
  let boot;
  let inbox = {};
  let inboxStorageKey;
  const notificationPanel = byId('customer-notifications');

  const queryId = () => new URLSearchParams(location.search).get('id');
  const rememberSelection = id => {
    try { localStorage.setItem('mb-account', id); } catch {}
    const url = new URL(location.href);
    url.searchParams.set('id', id);
    history.replaceState(null, '', url);
  };
  const currentDeliveries = () => latest?.fleetDeliveries?.length ? latest.fleetDeliveries : latest?.deliveries || [];
  const currentDelivery = () => currentDeliveries().find(delivery => delivery.id === selectedId) ?? null;

  function showPicker() {
    hidePopup();
    setNotificationsOpen(false);
    const deliveries = currentDeliveries();
    byId('account-list').innerHTML = deliveries.map(delivery => `<button class="acct" data-acct="${escapeHtml(delivery.id)}"><span><b>${escapeHtml(delivery.name)}</b><br><span class="sub">${escapeHtml(delivery.address || '배송지 정보 없음')}</span></span><span class="bx">${escapeHtml(delivery.boxes ?? '—')}박스</span></button>`).join('') || '<p class="loading-copy">조회할 배송이 없습니다.</p>';
    byId('account-picker').hidden = false;
  }

  function select(id) {
    hidePopup();
    setNotificationsOpen(false);
    selectedId = id;
    rememberSelection(id);
    popupBaseline = new Set(currentDelivery()?.notices?.map(notice => notice.id).filter(Boolean) || []);
    byId('account-picker').hidden = true;
    onSelect?.(id);
    render();
  }

  const noticesForCustomer = () => currentDelivery()?.notices || [];
  function saveInbox() {
    try { localStorage.setItem(inboxStorageKey, JSON.stringify(inbox)); } catch {}
  }
  function hidePopup() {
    clearTimeout(popupTimer);
    byId('customer-push').classList.remove('show');
    byId('customer-push').inert = true;
    popupNotice = null;
  }
  function setNotificationsOpen(open) {
    notificationPanel.hidden = !open;
    document.querySelector('.tracking-column').inert = open;
    byId('notification-bell').setAttribute('aria-expanded', String(open));
  }
  function updateUnreadCount() {
    const visible = visibleNotices(noticesForCustomer(), inbox);
    const count = visible.filter(notice => !inbox.read.includes(noticeKey(notice))).length;
    byId('notification-count').textContent = count > 99 ? '99+' : String(count);
    byId('notification-count').hidden = count === 0;
    byId('notification-bell').setAttribute('aria-label', count ? `알림, 읽지 않은 알림 ${count}개` : '알림');
    byId('notifications-read-all').disabled = count === 0;
    byId('notifications-clear').disabled = visible.length === 0;
  }
  function renderInbox() {
    const notices = noticesForCustomer();
    const storageKey = `mb-customer-inbox:${selectedId}`;
    if (inboxStorageKey !== storageKey) {
      inboxStorageKey = storageKey;
      try { inbox = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { inbox = {}; }
    }
    inbox = inboxState(notices, inbox, boot);
    const list = byId('customer-notification-list');
    const open = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.noticeKey));
    const focusKey = list.contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.noticeKey : null;
    const scroll = list.parentElement.scrollTop;
    const visible = visibleNotices(notices, inbox).slice().reverse();
    list.innerHTML = visible.map(notice => {
      const key = noticeKey(notice);
      const unread = !inbox.read.includes(key);
      return `<li><details data-notice-key="${escapeHtml(key)}" data-unread="${unread}"${open.has(key) ? ' open' : ''}><summary>${referenceIcon('expand')}<strong>${escapeHtml(notice.title || '고객 안내')}</strong><span class="notification-meta"><time>${escapeHtml(notice.time)}</time><span class="notification-read-state">${unread ? '읽지 않음' : '읽음'}</span></span></summary><p>${escapeHtml(customerNoticeBody(notice, currentDelivery()))}</p></details></li>`;
    }).join('');
    byId('notifications-empty').hidden = visible.length > 0;
    if (focusKey) [...list.querySelectorAll('details')].find(item => item.dataset.noticeKey === focusKey)?.querySelector('summary').focus({ preventScroll: true });
    list.parentElement.scrollTop = scroll;
    updateUnreadCount();
  }
  function showPopup(notice, delivery) {
    clearTimeout(popupTimer);
    popupNotice = notice;
    byId('customer-push-title').textContent = notice.title || '고객 안내';
    byId('customer-push-body').textContent = customerNoticeBody(notice, delivery);
    byId('customer-push-time').textContent = notice.time || '';
    byId('customer-push').inert = false;
    byId('customer-push').classList.remove('show');
    // Restart the existing entrance transition when scenarios change before dismissal.
    void byId('customer-push').offsetWidth;
    byId('customer-push').classList.add('show');
    popupTimer = setTimeout(hidePopup, 8000);
  }

  function renderRoad(coordinates) {
    if (!map) return;
    const data = { type: 'FeatureCollection', features: coordinates.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [] };
    const source = map.getSource('customer-demo-road');
    if (source) { source.setData(data); return; }
    if (!map.isStyleLoaded()) return;
    map.addSource('customer-demo-road', { type: 'geojson', data });
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    map.addLayer({ id: 'customer-demo-road-outline', type: 'line', source: 'customer-demo-road', layout, paint: { 'line-color': '#fff', 'line-width': 7, 'line-opacity': .9 } });
    map.addLayer({ id: 'customer-demo-road', type: 'line', source: 'customer-demo-road', layout, paint: { 'line-color': '#84cc16', 'line-width': 4 } });
  }

  function updateMap(delivery) {
    const point = routeData?.points?.find(item => item.id === delivery.id);
    const canMap = Boolean(map && point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
    const road = canMap && delivery.status !== 'done' ? customerDemoRoad(routeData, delivery.id) : [];
    renderRoad(road);
    byId('map').hidden = !canMap;
    byId('map-empty').hidden = canMap;
    if (!canMap || !map) return;
    map.resize();
    const home = [point.lng, point.lat];
    if (!homeMarker) homeMarker = createMarker('store', home);
    else homeMarker.setLngLat(home);
    if (!road.length) {
      if (truckMarker) { truckMarker.remove(); truckMarker = null; }
      map.jumpTo({ center: home, zoom: 15 });
      return;
    }
    const truck = delivery.arrivedAt ? road[road.length - 1] : road[0];
    if (!truckMarker) truckMarker = createMarker('vehicle', truck);
    else truckMarker.setLngLat(truck);
    const bounds = new maplibregl.LngLatBounds(home, home);
    road.forEach(coordinate => bounds.extend(coordinate));
    map.fitBounds(bounds, { padding: { top: 56, bottom: 48, left: 48, right: 48 }, maxZoom: 15, duration: 0 });
  }

  function render() {
    if (!latest) return;
    const delivery = currentDelivery();
    if (!delivery) return showPicker();
    byId('account-name').textContent = delivery.name || '배송지';
    const pill = byId('status-pill');
    pill.textContent = delivery.customerStatus?.label || '배송 조회';
    pill.className = `pill ${delivery.status === 'done' ? 'green' : ['shipping', 'nearby', 'arrived'].includes(delivery.customerStatus?.key) ? 'red' : delivery.status === 'skipped' ? 'amber' : 'gray'}`;
    byId('eta-text').textContent = customerEtaText(delivery);
    byId('eta-address').textContent = delivery.address || '배송지 정보 없음';
    byId('eta-boxes').textContent = delivery.boxes != null ? `${delivery.boxes}박스` : '미확인';
    byId('eta-delta').className = 'eta-delta';
    byId('eta-note').classList.remove('show');
    byId('order-no').textContent = delivery.orderNo || '';
    byId('order-items').innerHTML = (delivery.items || []).map(item => `<div class="item-row prod"><div><div class="nm">${escapeHtml(item.name)}</div><div class="op">${escapeHtml(item.opt)}</div></div><div class="qty">×${escapeHtml(item.qty)}</div></div>`).join('') || '<p class="empty">상품 상세 정보가 없습니다.</p>';
    byId('order-boxes').textContent = delivery.boxes != null ? `총 ${delivery.boxes}박스` : '박스 수량 미확인';
    byId('timeline').innerHTML = (delivery.timeline || []).map(item => `<li class="${escapeHtml(item.state)}">${escapeHtml(item.label)}${item.time ? `<span class="t">${escapeHtml(item.time)}</span>` : ''}</li>`).join('') || '<li>배송 이력 준비 중</li>';
    const notices = delivery.notices || [];
    renderInbox();
    const popupState = customerPopupState(popupBaseline, notices);
    popupBaseline = popupState.currentIds;
    const popup = popupState.popup;
    if (popup) showPopup(popup, delivery);
    updateMap(delivery);
  }

  byId('account-list').addEventListener('click', event => {
    const button = event.target.closest('[data-acct]');
    if (button) select(button.dataset.acct);
  });
  byId('switch-account').addEventListener('click', showPicker);
  byId('notification-bell').addEventListener('click', () => {
    const open = notificationPanel.hidden;
    setNotificationsOpen(open);
    if (open) byId('notifications-close').focus();
  });
  byId('notifications-close').addEventListener('click', () => {
    setNotificationsOpen(false);
    byId('notification-bell').focus();
  });
  notificationPanel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setNotificationsOpen(false);
    byId('notification-bell').focus();
  });
  byId('customer-notification-list').addEventListener('toggle', event => {
    const detail = event.target;
    const key = detail.dataset.noticeKey;
    if (!detail.open || !key || inbox.read.includes(key)) return;
    inbox = updateInbox(noticesForCustomer(), inbox, 'read', key);
    saveInbox();
    detail.dataset.unread = 'false';
    detail.querySelector('.notification-read-state').textContent = '읽음';
    updateUnreadCount();
  }, true);
  for (const [id, action] of [['notifications-read-all', 'read-all'], ['notifications-clear', 'clear']]) {
    byId(id).addEventListener('click', () => {
      inbox = updateInbox(noticesForCustomer(), inbox, action);
      saveInbox();
      if (action === 'clear') hidePopup();
      renderInbox();
      if (byId(id).disabled) byId('notifications-close').focus();
    });
  }
  byId('customer-push-close').addEventListener('click', hidePopup);
  byId('customer-push-open').addEventListener('click', () => {
    if (!popupNotice) return;
    const key = noticeKey(popupNotice);
    setNotificationsOpen(true);
    const detail = [...byId('customer-notification-list').querySelectorAll('details')].find(item => item.dataset.noticeKey === key);
    if (detail) { detail.open = true; detail.querySelector('summary').focus(); }
    hidePopup();
  });

  const loadRouteData = mb?.loadRouteData || (() => fetch('/scenario/api/route-data').then(response => {
    if (!response.ok) throw new Error('route data unavailable');
    return response.json();
  }));
  function createMarker(kind, coordinates) {
    const element = document.createElement('div');
    element.className = `customer-map-marker customer-map-marker--${kind}`;
    element.setAttribute('aria-label', kind === 'store' ? '매장 위치' : '예시 차량 위치');
    if (kind === 'store') element.innerHTML = '<span class="customer-map-house" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 3.2 3.5 8.4v8.1h4v-5h5v5h4V8.4L10 3.2Z"/></svg></span>';
    return new maplibregl.Marker({ element, anchor: kind === 'store' ? 'bottom' : 'center' }).setLngLat(coordinates).addTo(map);
  }
  const initMap = mb?.initMap || (element => {
    maplibregl.setWorkerUrl(new URL('./assets/vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href);
    const instance = new maplibregl.Map({
      container: element,
      style: new URL('./assets/maps/dsv-korea-v1.json', import.meta.url).href,
      center: [126.995, 37.43], zoom: 10.35,
      maxBounds: [124.5, 33, 132, 39.5],
      attributionControl: false, scrollZoom: false,
      dragRotate: false, touchPitch: false, pitchWithRotate: false, maxPitch: 0,
    });
    instance.touchZoomRotate.disableRotation();
    instance.addControl(new maplibregl.AttributionControl({ compact: true }));
    const attribution = element.querySelector('.maplibregl-ctrl-attrib');
    const collapseInitialAttribution = () => {
      if (!attribution.classList.contains('maplibregl-compact-show')) return;
      observer.disconnect();
      attribution.querySelector('summary').click();
    };
    const observer = new MutationObserver(collapseInitialAttribution);
    observer.observe(attribution, { attributes: true, attributeFilter: ['class'] });
    collapseInitialAttribution();
    instance.once('remove', () => observer.disconnect());
    return { map: instance };
  });
  Promise.resolve(loadRouteData()).then(data => {
    routeData = data;
    if (!map) {
      map = initMap(byId('map')).map;
      map.once('load', render);
    }
    render();
  }).catch(() => {
    byId('map').hidden = true;
    byId('map-empty').hidden = false;
    byId('map-empty').textContent = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
  });

  return {
    update(state, _raw, context = {}) {
      boot = context.boot;
      latest = state;
      byId('customer-clock').textContent = state.simClock || '--:--';
      const requested = queryId() || (() => { try { return localStorage.getItem('mb-account'); } catch { return null; } })();
      if (!selectedId && requested && currentDeliveries().some(delivery => delivery.id === requested)) {
        selectedId = requested;
        popupBaseline = new Set(currentDelivery()?.notices?.map(notice => notice.id).filter(Boolean) || []);
        byId('account-picker').hidden = true;
        onSelect?.(selectedId);
      }
      if (!selectedId) { popupBaseline = new Set(); showPicker(); return; }
      if (!currentDelivery()) { selectedId = null; showPicker(); return; }
      render();
    },
  };
}
