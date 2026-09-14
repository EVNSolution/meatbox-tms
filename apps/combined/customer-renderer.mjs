const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function customerEtaText(delivery) {
  if (delivery?.status === 'done') return delivery.completedAt ? `${delivery.completedAt} 배송 완료` : '배송 완료';
  if (delivery?.status === 'skipped') return '배송이 보류되었습니다';
  return delivery?.customerWindowText || '도착 예정 시간 계산 중';
}

export function customerNoticeBody(notice, delivery) {
  const body = String(notice?.body ?? '');
  if (notice?.kind === 'manual') return body;
  const precise = delivery?.preciseTimeText;
  const windowText = delivery?.customerWindowText;
  return precise && windowText ? body.replaceAll(precise, windowText) : body;
}

export function nextCustomerPopup(previousIds, notices) {
  return notices.find(notice => notice.id && !previousIds.has(notice.id)) ?? null;
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
  let popupReturnFocus;
  const dialog = byId('customer-notification-dialog');

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
    const deliveries = currentDeliveries();
    byId('account-list').innerHTML = deliveries.map(delivery => `<button class="acct" data-acct="${escapeHtml(delivery.id)}"><span class="thumb">🍖</span><span><b>${escapeHtml(delivery.name)}</b><br><span class="sub">${escapeHtml(delivery.address || '배송지 정보 없음')}</span></span><span class="bx">${escapeHtml(delivery.boxes ?? '—')}박스</span></button>`).join('') || '<p class="loading-copy">조회할 배송이 없습니다.</p>';
    byId('account-picker').hidden = false;
  }

  function select(id) {
    selectedId = id;
    rememberSelection(id);
    popupBaseline = new Set(currentDelivery()?.notices?.map(notice => notice.id).filter(Boolean) || []);
    byId('account-picker').hidden = true;
    onSelect?.(id);
    render();
  }

  function showPopup(notice, delivery) {
    clearTimeout(popupTimer);
    popupReturnFocus = document.activeElement;
    byId('customer-notification-title').textContent = notice.title || '고객 안내';
    byId('customer-notification-body').textContent = customerNoticeBody(notice, delivery);
    byId('customer-notification-time').textContent = notice.time || '';
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
    popupTimer = setTimeout(() => { if (dialog.open) dialog.close(); }, 8000);
  }

  function updateMap(delivery) {
    const point = routeData?.points?.find(item => item.id === delivery.id);
    const canMap = Boolean(point && latest?.rawTruck && Number.isFinite(latest.rawTruck.lat) && Number.isFinite(latest.rawTruck.lng));
    byId('map').hidden = !canMap;
    byId('map-empty').hidden = canMap;
    if (!canMap || !map) return;
    if (!homeMarker) homeMarker = L.marker([point.lat, point.lng], { icon: L.divIcon({ className: '', html: '<div class="marker-home">🏠</div>', iconSize: [32, 32], iconAnchor: [16, 16] }) }).addTo(map);
    else homeMarker.setLatLng([point.lat, point.lng]);
    if (delivery.status === 'done') {
      if (truckMarker) { map.removeLayer(truckMarker); truckMarker = null; }
      map.setView([point.lat, point.lng], 15);
      return;
    }
    const truck = [latest.rawTruck.lat, latest.rawTruck.lng];
    if (!truckMarker) truckMarker = L.marker(truck, { icon: L.divIcon({ className: '', html: '<div class="marker-truck">🚚</div>', iconSize: [38, 38], iconAnchor: [19, 19] }), zIndexOffset: 1000 }).addTo(map);
    else truckMarker.setLatLng(truck);
    map.fitBounds(L.latLngBounds([truck, [point.lat, point.lng]]).pad(0.3));
    setTimeout(() => map.invalidateSize(), 0);
  }

  function render() {
    if (!latest) return;
    const delivery = currentDelivery();
    if (!delivery) return showPicker();
    byId('account-name').textContent = delivery.name || '배송지';
    const pill = byId('status-pill');
    pill.textContent = delivery.customerStatus?.label || '배송 조회';
    pill.className = `pill ${delivery.status === 'done' ? 'green' : ['shipping', 'nearby'].includes(delivery.customerStatus?.key) ? 'red' : delivery.status === 'skipped' ? 'amber' : 'gray'}`;
    byId('eta-text').textContent = customerEtaText(delivery);
    byId('eta-sub').textContent = [delivery.name, delivery.address, delivery.boxes != null ? `${delivery.boxes}박스` : null].filter(Boolean).join(' · ');
    byId('eta-delta').className = 'eta-delta';
    byId('eta-note').classList.remove('show');
    byId('order-no').textContent = delivery.orderNo || '';
    byId('order-items').innerHTML = (delivery.items || []).map(item => `<div class="item-row prod"><div class="thumb">${escapeHtml(item.icon || '📦')}</div><div><div class="nm">${escapeHtml(item.name)}</div><div class="op">${escapeHtml(item.opt)}</div></div><div class="qty">×${escapeHtml(item.qty)}</div></div>`).join('') || '<p class="empty">상품 상세는 예시 데이터에 포함되지 않았습니다.</p>';
    byId('order-boxes').textContent = delivery.boxes != null ? `총 ${delivery.boxes}박스` : '박스 수량 미확인';
    byId('timeline').innerHTML = (delivery.timeline || []).map(item => `<li class="${escapeHtml(item.state)}">${escapeHtml(item.label)}${item.time ? `<span class="t">${escapeHtml(item.time)}</span>` : ''}</li>`).join('') || '<li>배송 이력 준비 중</li>';
    const notices = delivery.notices || [];
    byId('talk-list').innerHTML = notices.length ? notices.map(notice => `<div class="bubble"><div class="bt">${escapeHtml(notice.title)}</div>${escapeHtml(customerNoticeBody(notice, delivery))}<div class="bwhen">${escapeHtml(notice.time)}</div></div>`).join('') : '<p class="empty">아직 도착한 알림이 없어요</p>';
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
  byId('customer-notification-close').addEventListener('click', () => { clearTimeout(popupTimer); dialog.close(); });
  dialog.addEventListener('close', () => {
    if (popupReturnFocus instanceof HTMLElement && popupReturnFocus.isConnected) popupReturnFocus.focus();
    else document.querySelector('.viewer-screen')?.focus();
  });

  const loadRouteData = mb?.loadRouteData || (() => fetch('/scenario/api/route-data').then(response => {
    if (!response.ok) throw new Error('route data unavailable');
    return response.json();
  }));
  const initMap = mb?.initMap || (element => {
    const instance = L.map(element, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(instance);
    L.control.attribution({ prefix: false }).addAttribution('© OpenStreetMap').addTo(instance);
    return { map: instance };
  });
  Promise.resolve(loadRouteData()).then(data => {
    routeData = data;
    if (globalThis.L && !map) map = initMap(byId('map')).map;
    render();
  }).catch(() => { byId('map').hidden = true; byId('map-empty').hidden = false; });

  return {
    update(state, raw) {
      latest = { ...state, rawTruck: raw?.truck };
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
