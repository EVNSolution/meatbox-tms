import { referenceIcon } from './reference-icons.mjs';
import { inboxState, noticeKey, visibleNotices, updateInbox } from './customer-inbox.mjs';
import { customerDemoRoad } from './customer-demo-route.mjs';
import { customerPickerPage, updateCustomerPickerState } from './customer-picker-model.mjs';
import { sourceVehicleContext } from './source-context.mjs';
import { transportConditionText } from './source-viewer-plan.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function customerLocationName(delivery) {
  return /^(?:\d+|\d+층|지층)$/.test(String(delivery?.name ?? '').trim())
    ? delivery.address || '배송지' : delivery?.name || delivery?.address || '배송지';
}

export function customerOrderSummary(delivery) {
  const orders = Array.isArray(delivery?.orders) && delivery.orders.length ? delivery.orders : [delivery].filter(Boolean);
  const numbers = orders.map(order => order.orderNumber || order.orderNo).filter(Boolean);
  const items = orders.flatMap(order => Array.isArray(order.items) ? order.items : []);
  return {
    orderText: numbers.length ? numbers.join(', ') : '주문 번호 미제공',
    items,
    emptyText: `상품 상세 미제공 · 주문 ${orders.length}건 / 총 ${delivery?.boxes ?? '—'}박스`,
  };
}

export function customerDeliveryForId(deliveries, id) {
  return deliveries.find(delivery => delivery.id === id || delivery.orderIds?.includes(id)
    || delivery.orders?.some(order => order.id === id)) ?? null;
}

export function customerEtaText(delivery) {
  if (delivery?.dispatchPending) return '배차 확정 대기';
  if (delivery?.status === 'done') return delivery.completedAt ? `${delivery.completedAt} 배송 완료` : '배송 완료';
  if (delivery?.status === 'skipped') return '배송이 보류되었습니다';
  if (delivery?.status === 'current' && delivery.arrivedAt) return `${delivery.arrivedAt} 도착`;
  return delivery?.customerWindowText
    ? `${delivery.customerWindowText}${['operating-plan', 'customer-demo'].includes(delivery.etaSource) ? ' 도착 예정' : ''}`
    : '시간 정보 미제공';
}

const validCoordinate = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

export function customerViewerDeliveries(state) {
  if (state?.customerDemo) return state.fleetDeliveries || [];
  if (!state?.sourceData) return state?.fleetDeliveries?.length ? state.fleetDeliveries : state?.deliveries || [];
  if (!state.dispatch || ['published', 'amending'].includes(state.dispatch.phase)) return Array.isArray(state.fleetDeliveries) ? state.fleetDeliveries : [];
  return (Array.isArray(state.dispatchOrders) ? state.dispatchOrders : []).map(order => {
    const safe = { ...order };
    for (const key of ['vehicle', 'vehicleId', 'driver', 'plate', 'currentGroupId', 'officialEta', 'calculatedEta', 'preciseTimeText',
      'customerWindowText', 'customerWindowStart', 'customerWindowEnd', 'etaSource', 'arrivedAt', 'completedAt']) delete safe[key];
    return {
      ...safe,
      status: 'pending',
      statusTone: 'neutral',
      customerStatus: { key: 'dispatch-waiting', label: '배차 대기' },
      customerStatusTone: 'neutral',
      ordered: true,
      timeline: [],
      dispatchPending: true,
    };
  });
}

export function customerMapView(delivery, state, routeData) {
  if (state?.sourceData) {
    const home = validCoordinate(delivery?.coordinates) ? [...delivery.coordinates] : null;
    if (state.customerDemo) return { home, road: [], truck: home && validCoordinate(delivery?.customerDemo?.truck) ? [...delivery.customerDemo.truck] : null };
    if (state.dispatch && !['published', 'amending'].includes(state.dispatch.phase)) return { home, road: [], truck: null };
    const vehicle = delivery?.vehicle || state.fleetVehicles?.find(item => item.id === delivery?.vehicleId) || state.vehicle;
    const operationPosition = state.vehicleStates?.[vehicle?.id]?.truck || state.truck;
    const operationCoordinates = operationPosition && [operationPosition.lng, operationPosition.lat];
    const truck = delivery?.status !== 'done' && operationPosition?.locationSource === 'demo' && validCoordinate(operationCoordinates)
      ? operationCoordinates
      : delivery?.status !== 'done' && vehicle?.location?.source === 'demo' && validCoordinate(vehicle.location.coordinates)
        ? [...vehicle.location.coordinates]
      : null;
    return { home, road: [], truck };
  }
  const point = routeData?.points?.find(item => item.id === delivery?.id);
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return { home: null, road: [], truck: null };
  const home = [point.lng, point.lat];
  const road = delivery.status !== 'done' ? customerDemoRoad(routeData, delivery.id) : [];
  const truck = road.length ? (delivery.arrivedAt ? road.at(-1) : road[0]) : null;
  return { home, road, truck };
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
  let latest, fullLatest;
  let selectedId;
  let routeData;
  let routeLoading = false, routeFailed = false;
  let map;
  let mapViewSignature = '';
  let homeMarker;
  let truckMarker;
  let popupBaseline = new Set();
  let popupTimer;
  let popupNotice;
  let boot;
  let inbox = {};
  let inboxStorageKey;
  let pickerState = { query: '', page: 1 };
  const notificationPanel = byId('customer-notifications');

  const queryId = () => new URLSearchParams(location.search).get('id');
  const rememberSelection = id => {
    try { localStorage.setItem('mb-account', id); } catch {}
    const url = new URL(location.href);
    url.searchParams.set('id', id);
    history.replaceState(null, '', url);
  };
  const currentDeliveries = () => customerViewerDeliveries(latest);
  const currentDelivery = () => customerDeliveryForId(currentDeliveries(), selectedId);

  function renderPicker() {
    const result = customerPickerPage(currentDeliveries(), pickerState);
    pickerState.page = result.page;
    const search = byId('account-search');
    if (search.value !== pickerState.query) search.value = pickerState.query;
    byId('account-search-reset').disabled = !pickerState.query;
    byId('account-result-count').textContent = result.total ? `검색 결과 ${result.total}개 중 ${result.start}-${result.end}개` : '검색 결과가 없습니다.';
    byId('account-list').innerHTML = result.items.map(delivery => `<button class="acct" data-acct="${escapeHtml(delivery.id)}"${customerDeliveryForId([delivery], selectedId) ? ' aria-current="true"' : ''}><span><b>${escapeHtml(customerLocationName(delivery))}</b><span class="sub">${escapeHtml(delivery.address || '배송지 정보 없음')}</span></span><span class="bx">${escapeHtml(delivery.boxes ?? '—')}박스</span></button>`).join('') || '<p class="loading-copy">조건에 맞는 매장이 없습니다.</p>';
    byId('account-page').textContent = `${result.page} / ${result.pageCount}`;
    byId('account-previous').disabled = result.page <= 1;
    byId('account-next').disabled = result.page >= result.pageCount;
  }

  function showPicker() {
    hidePopup();
    setNotificationsOpen(false);
    const wasHidden = byId('account-picker').hidden;
    renderPicker();
    byId('account-picker').hidden = false;
    if (wasHidden) requestAnimationFrame(() => byId('account-search').focus());
  }

  function select(id) {
    hidePopup();
    setNotificationsOpen(false);
    selectedId = id;
    latest = sourceVehicleContext(fullLatest, selectedId);
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
    const view = customerMapView(delivery, latest, routeData);
    const canMap = Boolean(map && view.home);
    const road = canMap ? view.road : [];
    byId('map').setAttribute('aria-label', latest.customerDemo ? '매장과 예시 차량 위치 지도' : latest.sourceData
      ? delivery.dispatchPending ? '배송지 위치 지도' : '배송지와 차량 위치 지도'
      : '예시 차량 위치와 매장까지의 도로 경로 지도');
    renderRoad(road);
    byId('map').hidden = !canMap;
    byId('map-empty').hidden = canMap;
    if (!canMap || !map) { mapViewSignature = ''; return; }
    map.resize();
    const home = view.home;
    const nextViewSignature = `${delivery.id}|${home}|${view.truck || ''}|${road.length}|${road[0] || ''}|${road.at(-1) || ''}`;
    const viewChanged = nextViewSignature !== mapViewSignature;
    mapViewSignature = nextViewSignature;
    if (!homeMarker) homeMarker = createMarker('store', home);
    else homeMarker.setLngLat(home);
    if (!view.truck) {
      if (truckMarker) { truckMarker.remove(); truckMarker = null; }
      if (viewChanged) map.jumpTo({ center: home, zoom: 15 });
      return;
    }
    const truck = view.truck;
    if (!truckMarker) truckMarker = createMarker('vehicle', truck, Boolean(latest.sourceData && !latest.customerDemo));
    else truckMarker.setLngLat(truck);
    truckMarker.getElement().setAttribute('aria-label', latest.customerDemo || !latest.sourceData ? '예시 차량 위치' : '차량 위치');
    if (viewChanged) {
      const bounds = new maplibregl.LngLatBounds(home, home);
      road.forEach(coordinate => bounds.extend(coordinate));
      bounds.extend(truck);
      map.fitBounds(bounds, { padding: { top: 56, bottom: 48, left: 48, right: 48 }, maxZoom: 15, duration: 0 });
    }
  }

  function render() {
    if (!latest) return;
    const delivery = currentDelivery();
    if (!delivery) return showPicker();
    byId('customer-viewer-summary').textContent = latest.customerDemo?.active
      ? '고객 시연 중 · 배송 상태, 시각과 차량 위치는 예시입니다.'
      : '선택한 매장의 배송 현황과 고객 안내를 확인합니다.';
    const demoLabel = byId('customer-demo-label');
    demoLabel.hidden = !latest.customerDemo;
    demoLabel.textContent = latest.customerDemo?.active
      ? '고객 시연 · 배송 상태와 시각은 예시입니다.'
      : '예시 차량 위치 · 시나리오에서 배송 과정을 시연할 수 있습니다.';
    byId('account-name').textContent = customerLocationName(delivery);
    const pill = byId('status-pill');
    pill.textContent = delivery.customerStatus?.label || '배송 조회';
    pill.className = `pill ${delivery.status === 'done' ? 'green' : ['shipping', 'nearby', 'arrived'].includes(delivery.customerStatus?.key) ? 'red' : delivery.status === 'skipped' ? 'amber' : 'gray'}`;
    byId('eta-text').textContent = customerEtaText(delivery);
    byId('eta-address').textContent = delivery.address || '배송지 정보 없음';
    byId('eta-boxes').textContent = delivery.boxes != null ? `${delivery.boxes}박스` : '미확인';
    const transport = byId('eta-transport');
    if (transport) {
      transport.textContent = latest.sourceData ? transportConditionText(delivery) : '';
      transport.parentElement.hidden = !transport.textContent;
    }
    byId('eta-delta').className = 'eta-delta';
    byId('eta-note').classList.remove('show');
    const orderSummary = customerOrderSummary(delivery);
    byId('order-no').textContent = orderSummary.orderText;
    byId('order-items').innerHTML = orderSummary.items.map(item => `<div class="item-row prod"><div><div class="nm">${escapeHtml(item.name)}</div><div class="op">${escapeHtml(item.opt)}</div></div><div class="qty">×${escapeHtml(item.qty)}</div></div>`).join('') || `<p class="empty">${escapeHtml(orderSummary.emptyText)}</p>`;
    byId('order-boxes').textContent = delivery.boxes != null ? `총 ${delivery.boxes}박스` : '박스 수량 미확인';
    byId('timeline').innerHTML = (delivery.timeline || []).map(item => `<li class="${escapeHtml(item.state)}">${escapeHtml(item.label)}${item.time ? `<span class="t">${escapeHtml(item.time)}</span>` : ''}</li>`).join('')
      || `<li>${delivery.dispatchPending ? '배차 확정 대기' : '배송 이력 준비 중'}</li>`;
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
  byId('account-search').addEventListener('input', event => {
    pickerState = updateCustomerPickerState(pickerState, { query: event.currentTarget.value });
    renderPicker();
  });
  byId('account-search-reset').addEventListener('click', () => {
    pickerState = updateCustomerPickerState(pickerState, { query: '' });
    renderPicker();
    byId('account-search').focus();
  });
  for (const [id, direction] of [['account-previous', -1], ['account-next', 1]]) {
    byId(id).addEventListener('click', () => {
      pickerState = updateCustomerPickerState(pickerState, { page: pickerState.page + direction });
      renderPicker();
      byId('account-list').querySelector('button')?.focus();
    });
  }
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
  function createMarker(kind, coordinates, operational = false) {
    const element = document.createElement('div');
    element.className = `customer-map-marker customer-map-marker--${kind}`;
    element.setAttribute('aria-label', kind === 'store' ? '매장 위치' : operational ? '차량 위치' : '예시 차량 위치');
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
      attributionControl: false, scrollZoom: true,
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
  function ensureMap() {
    if (!map) {
      map = initMap(byId('map')).map;
      map.once('load', render);
    }
  }
  ensureMap();
  function loadLegacyRoute() {
    if (routeData || routeLoading || routeFailed) return;
    routeLoading = true;
    Promise.resolve(loadRouteData()).then(data => {
      routeData = data;
      render();
    }).catch(() => {
      routeFailed = true;
      byId('map').hidden = true;
      byId('map-empty').hidden = false;
      byId('map-empty').textContent = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
    }).finally(() => { routeLoading = false; });
  }

  return {
    select,
    update(state, _raw, context = {}) {
      boot = context.boot;
      fullLatest = state;
      latest = state;
      if (!state.sourceData) loadLegacyRoute();
      byId('customer-clock').textContent = state.simClock || '--:--';
      byId('customer-clock').setAttribute('aria-label', state.customerDemo?.active ? '시연 시각' : '현재 시각');
      const requested = queryId() || (() => { try { return localStorage.getItem('mb-account'); } catch { return null; } })();
      const available = currentDeliveries();
      const fallback = state.sourceData?.defaultStopId;
      const candidate = customerDeliveryForId(available, requested) ?? customerDeliveryForId(available, fallback);
      const resolved = customerDeliveryForId(available, selectedId) ?? candidate;
      if (resolved && resolved.id !== selectedId) {
        selectedId = resolved.id;
        latest = sourceVehicleContext(fullLatest, selectedId);
        rememberSelection(selectedId);
        popupBaseline = new Set(currentDelivery()?.notices?.map(notice => notice.id).filter(Boolean) || []);
        byId('account-picker').hidden = true;
        onSelect?.(selectedId);
      }
      latest = sourceVehicleContext(fullLatest, selectedId);
      if (!selectedId) { popupBaseline = new Set(); showPicker(); return latest; }
      if (!currentDelivery()) { selectedId = null; showPicker(); return latest; }
      render();
      if (!byId('account-picker').hidden) renderPicker();
      return latest;
    },
  };
}
