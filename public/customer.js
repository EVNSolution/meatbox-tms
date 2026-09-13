(async () => {
  const rd = await MB.loadRouteData();
  const { map } = MB.initMap(document.getElementById('map'), { scrollWheelZoom: false });

  const $ = (id) => document.getElementById(id);
  let lastNotifCount = null;
  let lastEtaKey = null;
  let pushTimer = null;
  let truckMarker = null;
  let homeMarker = null;
  let fitted = false;

  // 소비자 지도: 차량 위치 + 내 위치만 표시 (다른 배송지는 노출하지 않음)
  function updateMap(s) {
    const home = rd.points.find((p) => p.id === s.customerStopId);
    if (!homeMarker) {
      homeMarker = L.marker([home.lat, home.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-home">🏠</div>', iconSize: [32, 32], iconAnchor: [16, 16] }),
      }).addTo(map);
    }
    const delivered = s.order.find((o) => o.id === s.customerStopId)?.status === 'done';
    if (delivered) {
      // 배송 완료 후에는 차량을 더 이상 보여주지 않음
      if (truckMarker) { map.removeLayer(truckMarker); truckMarker = null; }
      map.setView([home.lat, home.lng], 15);
      return;
    }
    const pos = [s.truck.lat, s.truck.lng];
    if (!truckMarker) {
      truckMarker = L.marker(pos, {
        icon: L.divIcon({ className: '', html: '<div class="marker-truck">🚚</div>', iconSize: [38, 38], iconAnchor: [19, 19] }),
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      truckMarker.setLatLng(pos);
    }
    const bounds = L.latLngBounds([pos, [home.lat, home.lng]]).pad(0.3);
    if (!fitted) { map.fitBounds(bounds); fitted = true; }
    else if (!map.getBounds().contains(pos)) map.fitBounds(bounds);
  }

  function showPush(n) {
    $('push-title').textContent = n.title;
    $('push-body').textContent = n.body;
    $('push-when').textContent = n.time;
    const el = $('push');
    el.classList.add('show');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => el.classList.remove('show'), 5200);
  }

  let wasUnordered = null;
  document.getElementById('place-order').addEventListener('click', () => MB.send('place_order'));

  MB.connect((s) => {
    // 주문 전: 주문 화면 / 주문 후: 트래킹 화면
    const unordered = s.phase === 'unordered';
    $('order-cta').hidden = !unordered;
    for (const id of ['eta-card', 'map-card', 'timeline-card', 'talk-card']) $(id).hidden = unordered;
    if (wasUnordered && !unordered) {
      // 숨김 상태에서 초기화된 지도 크기 보정
      fitted = false;
      setTimeout(() => map.invalidateSize(), 60);
    }
    wasUnordered = unordered;

    // 알림 (푸시 배너 + 알림톡 피드) — 새로 늘어난 알림만 배너로 표시
    if (lastNotifCount !== null && s.notifications.length > lastNotifCount) {
      showPush(s.notifications[s.notifications.length - 1]);
    }
    lastNotifCount = s.notifications.length;
    $('talk-list').innerHTML = s.notifications.length
      ? s.notifications
          .map((n) => `<div class="bubble"><div class="bt">${n.title}</div>${n.body}<div class="bwhen">${n.time}</div></div>`)
          .join('')
      : '<div class="empty">아직 도착한 알림이 없어요</div>';

    if (unordered) return;

    // 상태 배지
    const st = s.customerStatus;
    const pill = $('status-pill');
    pill.textContent = st.label;
    pill.className = 'pill ' + (st.key === 'delivered' ? 'green' : st.key === 'nearby' ? 'red' : 'gray');

    // ETA 카드
    if (s.eta) {
      $('eta-text').innerHTML = `${s.eta.timeText} <span style="font-size:15px;">도착 예정</span>`;
      const etaKey = s.eta.timeText;
      if (lastEtaKey && etaKey !== lastEtaKey) {
        $('eta-card').classList.remove('flash');
        void $('eta-card').offsetWidth;
        $('eta-card').classList.add('flash');
        const d = $('eta-delta');
        if (s.eta.deltaMin && Math.abs(s.eta.deltaMin) >= 3) {
          d.textContent = `${s.eta.deltaMin > 0 ? '+' : ''}${s.eta.deltaMin}분 · ${s.eta.reason}`;
          d.className = 'eta-delta ' + (s.eta.deltaMin > 0 ? 'plus' : 'minus');
          const note = $('eta-note');
          note.textContent = `배송 예정 시간이 변경되었습니다 (${s.eta.reason}). 변경된 시간 기준으로 안내드려요.`;
          note.classList.add('show');
        }
      }
      lastEtaKey = etaKey;
    } else if (st.key === 'delivered') {
      const done = s.order.find((o) => o.id === s.customerStopId);
      $('eta-text').innerHTML = `${done.deliveredTime} <span style="font-size:15px;">배송 완료</span> ✅`;
      $('eta-delta').className = 'eta-delta';
      $('eta-note').classList.remove('show');
    } else {
      $('eta-text').textContent = '도착 예정 계산 중…';
    }

    // 타임라인
    $('timeline').innerHTML = s.timeline
      .map((t) => `<li class="${t.state}">${t.label}${t.time ? `<span class="t">${t.time}</span>` : ''}</li>`)
      .join('');

    // 지도
    updateMap(s);
  });
})();
