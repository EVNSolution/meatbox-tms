(() => {
  const $ = (id) => document.getElementById(id);

  $('scan').addEventListener('click', () => MB.send('complete_stop'));
  $('stops').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-stop]');
    if (btn) MB.send('reorder', { stopId: btn.dataset.stop, dir: btn.dataset.dir });
  });

  MB.connect((s) => {
    $('clock').textContent = s.simClock;

    // 현재 목적지 카드
    const current = s.order.find((o) => o.status === 'current');
    const navState = $('nav-state');
    if (s.phase === 'idle' || s.phase === 'preparing') {
      navState.textContent = s.phase === 'idle' ? '배차 대기' : 'MFC 상차 중';
      navState.className = 'pill gray';
      $('nav-dest').textContent = '가락 MFC';
      $('nav-addr').textContent = '서울 송파구 양재대로 932';
      $('nav-dist').textContent = '—';
      $('nav-boxes').textContent = '70박스';
      $('nav-order').textContent = '0/8';
      $('scan').disabled = true;
    } else if (s.phase === 'done') {
      navState.textContent = '배송 완료';
      navState.className = 'pill green';
      $('nav-dest').textContent = '금일 배송 전체 완료 🎉';
      $('nav-addr').textContent = 'MFC 복귀';
      $('scan').disabled = true;
    } else if (current) {
      const idx = s.order.indexOf(current);
      navState.textContent = s.truck.dwelling ? `하차 중 (남은 ${Math.ceil(s.truck.dwellRemaining / 60)}분)` : '이동 중';
      navState.className = s.truck.dwelling ? 'pill amber' : 'pill red';
      $('nav-dest').textContent = `${idx + 1}. ${current.name}`;
      $('nav-addr').textContent = current.address;
      $('nav-dist').textContent = s.truck.dwelling ? '도착' : MB.fmtM(s.truck.remainingM);
      $('nav-boxes').textContent = `${current.boxes}박스`;
      $('nav-order').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}`;
      $('scan').disabled = !s.truck.dwelling;
    }

    // 배송 리스트
    $('stops').innerHTML = s.order
      .map((o, i) => {
        const star = o.id === s.customerStopId ? ' ⭐' : '';
        let right;
        if (o.status === 'done') right = `<span class="stamp">✓ ${o.deliveredTime}</span>`;
        else if (o.status === 'current') right = '<span class="now pill red">배송 중</span>';
        else {
          right = `<span class="ud">
            <button class="btn ghost sm" data-stop="${o.id}" data-dir="up">▲</button>
            <button class="btn ghost sm" data-stop="${o.id}" data-dir="down">▼</button>
          </span>`;
        }
        return `<div class="stop-row ${o.status}">
          <div class="no">${o.status === 'done' ? '✓' : i + 1}</div>
          <div><div class="nm">${o.name}${star}</div><div class="sub">${o.address} · ${o.boxes}박스</div></div>
          ${right}
        </div>`;
      })
      .join('');

    // 하단 요약
    $('f-done').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}`;
    $('f-left').textContent = `${s.kpi.boxesTotal - s.kpi.boxesDelivered}`;
    $('f-eta').textContent = s.eta ? `${s.eta.startText}~${s.eta.endText}` : '—';
  });
})();
