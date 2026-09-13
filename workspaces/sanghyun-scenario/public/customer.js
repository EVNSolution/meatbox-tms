(async () => {
  const rd = await MB.loadRouteData();
  const { map } = MB.initMap(document.getElementById('map'), { scrollWheelZoom: false });

  const $ = (id) => document.getElementById(id);
  let myId = null;
  let latestState = null;
  let lastNotifCount = null;
  let lastEtaKey = null;
  let pushTimer = null;
  let wasUnordered = null;
  let truckMarker = null;
  let homeMarker = null;
  let fitted = false;

  // ---------- 계정 선택 (데모용 로그인) ----------
  const savedId = new URLSearchParams(location.search).get('id') || (() => {
    try { return localStorage.getItem('mb-account'); } catch { return null; }
  })();

  function selectAccount(id) {
    myId = id;
    try { localStorage.setItem('mb-account', id); } catch {}
    // 딥링크(?id=)로 들어온 경우에도 선택이 유지되도록 URL을 함께 갱신
    try {
      const u = new URL(location.href);
      u.searchParams.set('id', id);
      history.replaceState(null, '', u);
    } catch {}
    // 계정별 화면 상태 초기화
    lastNotifCount = null; lastEtaKey = null; wasUnordered = null; fitted = false;
    if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
    if (truckMarker) { map.removeLayer(truckMarker); truckMarker = null; }
    $('eta-delta').className = 'eta-delta';
    $('eta-note').classList.remove('show');
    $('account-picker').hidden = true;
    if (latestState) render(latestState);
  }

  function showPicker(s) {
    $('account-list').innerHTML = s.order
      .map((o) => `<button class="acct" data-acct="${o.id}">
        <span class="thumb">🍖</span>
        <span><b>${o.name}</b><br><span class="sub">${o.address}</span></span>
        <span class="bx">${o.boxes}박스</span>
      </button>`)
      .join('');
    $('account-picker').hidden = false;
    const screen = document.querySelector('.screen');
    if (screen) screen.scrollTop = 0;
  }

  $('account-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-acct]');
    if (b) selectAccount(b.dataset.acct);
  });
  $('switch-account').addEventListener('click', () => { if (latestState) showPicker(latestState); });
  $('place-order').addEventListener('click', () => MB.send('place_order'));

  // ---------- 렌더링 ----------
  function showPush(n) {
    $('push-title').textContent = n.title;
    $('push-body').textContent = n.body;
    $('push-when').textContent = n.time;
    const el = $('push');
    el.classList.add('show');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => el.classList.remove('show'), 5200);
  }

  // 소비자 지도: 차량 위치 + 내 위치만 표시
  function updateMap(s, stop) {
    const home = rd.points.find((p) => p.id === myId);
    if (!homeMarker) {
      homeMarker = L.marker([home.lat, home.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-home">🏠</div>', iconSize: [32, 32], iconAnchor: [16, 16] }),
      }).addTo(map);
    }
    if (stop.status === 'done') {
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

  function render(s) {
    const stop = s.order.find((o) => o.id === myId);
    const c = s.customers[myId];
    if (!stop || !c) { showPicker(s); return; }
    $('account-name').textContent = stop.name;

    // 주문 전(주인공 계정만): 주문 화면 / 그 외: 트래킹 화면
    const unordered = !c.ordered;
    $('order-cta').hidden = !unordered;
    for (const id of ['eta-card', 'map-card', 'timeline-card', 'talk-card']) $(id).hidden = unordered;
    if (wasUnordered && !unordered) {
      fitted = false;
      setTimeout(() => map.invalidateSize(), 60);
    }
    wasUnordered = unordered;

    // 내 계정 알림만 필터링 — 새로 늘어난 알림만 배너 표시
    const mine = s.notifications.filter((n) => n.stopId === myId);
    if (lastNotifCount !== null && mine.length > lastNotifCount) showPush(mine[mine.length - 1]);
    lastNotifCount = mine.length;
    $('talk-list').innerHTML = mine.length
      ? mine.map((n) => `<div class="bubble"><div class="bt">${n.title}</div>${n.body}<div class="bwhen">${n.time}</div></div>`).join('')
      : '<div class="empty">아직 도착한 알림이 없어요</div>';

    // 주문 상품
    $('order-no').textContent = `주문번호 MB-20260912-84${70 + Number(myId.slice(1))}`;
    $('order-items').innerHTML = stop.items
      .map((it) => `<div class="item-row prod">
        <div class="thumb">${it.icon}</div>
        <div><div class="nm">${it.name}</div><div class="op">${it.opt}</div></div>
        <div class="qty">×${it.qty}</div>
      </div>`)
      .join('');
    $('order-boxes').textContent = `총 ${stop.boxes}박스`;

    if (unordered) return;

    // 상태 배지
    const st = c.status;
    const pill = $('status-pill');
    pill.textContent = st.label;
    pill.className = 'pill ' + (
      st.key === 'delivered' ? 'green'
      : st.key === 'nearby' || st.key === 'shipping' ? 'red'
      : st.key === 'held' ? 'amber' : 'gray');

    // ETA 카드
    $('eta-sub').textContent = `${stop.name} · ${stop.address} · ${stop.boxes}박스`;
    if (c.eta) {
      $('eta-text').innerHTML = `${c.eta.timeText} <span style="font-size:15px;">도착 예정</span>`;
      const etaKey = c.eta.timeText;
      if (lastEtaKey && etaKey !== lastEtaKey) {
        $('eta-card').classList.remove('flash');
        void $('eta-card').offsetWidth;
        $('eta-card').classList.add('flash');
        const d = $('eta-delta');
        if (c.eta.deltaMin && Math.abs(c.eta.deltaMin) >= 3) {
          d.textContent = `${c.eta.deltaMin > 0 ? '+' : ''}${c.eta.deltaMin}분 · ${c.eta.reason}`;
          d.className = 'eta-delta ' + (c.eta.deltaMin > 0 ? 'plus' : 'minus');
          const note = $('eta-note');
          note.textContent = `배송 예정 시간이 변경되었습니다 (${c.eta.reason}). 변경된 시간 기준으로 안내드려요.`;
          note.classList.add('show');
        }
      }
      lastEtaKey = etaKey;
    } else if (st.key === 'delivered') {
      $('eta-text').innerHTML = `${stop.deliveredTime} <span style="font-size:15px;">배송 완료</span> ✅`;
      $('eta-delta').className = 'eta-delta';
      $('eta-note').classList.remove('show');
    } else if (st.key === 'held') {
      $('eta-text').innerHTML = '<span style="font-size:17px;">배송이 보류되었습니다 — 고객센터에서 안내드릴 예정이에요</span>';
    } else {
      $('eta-text').textContent = '도착 예정 계산 중…';
    }

    // 타임라인
    $('timeline').innerHTML = c.timeline
      .map((t) => `<li class="${t.state}">${t.label}${t.time ? `<span class="t">${t.time}</span>` : ''}</li>`)
      .join('');

    // 지도
    updateMap(s, stop);
  }

  MB.connect((s) => {
    latestState = s;
    if (!myId) {
      if (savedId && s.order.some((o) => o.id === savedId)) { selectAccount(savedId); return; }
      showPicker(s);
      return;
    }
    render(s);
  });
})();
