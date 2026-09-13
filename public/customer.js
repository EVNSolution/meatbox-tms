(async () => {
  const rd = await MB.loadRouteData();
  const ctx = MB.initMap(document.getElementById('map'), { scrollWheelZoom: false });

  const $ = (id) => document.getElementById(id);
  let lastNotifId = null;
  let firstState = true;
  let lastEtaKey = null;
  let pushTimer = null;

  function showPush(n) {
    $('push-title').textContent = n.title;
    $('push-body').textContent = n.body;
    $('push-when').textContent = n.time;
    const el = $('push');
    el.classList.add('show');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => el.classList.remove('show'), 5200);
  }

  MB.connect((s) => {
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
    MB.renderRoute(ctx, rd, s);
    if (firstState) {
      firstState = false;
      const home = rd.points.find((p) => p.id === s.customerStopId);
      L.marker([home.lat, home.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-home">🏠</div>', iconSize: [32, 32], iconAnchor: [16, 16] }),
        zIndexOffset: 900,
      }).addTo(ctx.map);
    }

    // 알림 (푸시 배너 + 알림톡 피드)
    if (s.notifications.length) {
      const latest = s.notifications[s.notifications.length - 1];
      if (lastNotifId !== null && latest.id > lastNotifId) showPush(latest);
      lastNotifId = latest.id;
      $('talk-list').innerHTML = s.notifications
        .map((n) => `<div class="bubble"><div class="bt">${n.title}</div>${n.body}<div class="bwhen">${n.time}</div></div>`)
        .join('');
    } else {
      lastNotifId = null;
      $('talk-list').innerHTML = '<div class="empty">아직 도착한 알림이 없어요</div>';
    }
  });
})();
