(async () => {
  const rd = await MB.loadRouteData();
  const ctx = MB.initMap(document.getElementById('map'));
  const $ = (id) => document.getElementById(id);

  $('start').addEventListener('click', () => MB.send('start'));
  $('reset').addEventListener('click', () => MB.send('reset'));
  $('traffic').addEventListener('click', () => MB.send('inject_traffic'));
  $('dwell').addEventListener('click', () => MB.send('inject_dwell'));
  $('speed').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) MB.send('speed', { value: Number(b.dataset.v) });
  });

  const PHASE = {
    idle: ['대기', 'gray'],
    preparing: ['MFC 출고 중', 'amber'],
    delivering: ['배송 중', 'red'],
    done: ['금일 완료', 'green'],
  };
  const STATUS = { pending: ['대기', 'gray'], current: ['배송 중', 'red'], done: ['완료', 'green'] };

  MB.connect((s) => {
    $('clock').textContent = s.simClock;
    const [pl, pc] = PHASE[s.phase];
    $('phase').textContent = pl;
    $('phase').className = `pill ${pc} phase`;

    $('start').disabled = s.phase !== 'idle';
    $('traffic').disabled = s.phase !== 'delivering' || s.incidents.length > 0;
    $('dwell').disabled = s.phase !== 'delivering';
    for (const b of $('speed').querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.v) === s.speed);
    }

    // KPI
    $('k-load').textContent = `${s.kpi.boxesTotal - s.kpi.boxesDelivered}/${s.kpi.boxesTotal}박스`;
    $('k-done').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}착지`;
    $('k-eta').textContent = s.eta
      ? `${s.eta.startText}~${s.eta.endText}`
      : s.order.find((o) => o.id === s.customerStopId)?.deliveredTime
        ? `${s.order.find((o) => o.id === s.customerStopId).deliveredTime} 완료`
        : '—';
    $('incident').style.display = s.incidents.length ? 'inline-flex' : 'none';

    // 정차지 테이블
    $('stops').innerHTML = s.order
      .map((o, i) => {
        const [sl, sc] = STATUS[o.status];
        const star = o.id === s.customerStopId ? ' ⭐' : '';
        return `<tr>
          <td style="width:22px;font-weight:800;">${i + 1}</td>
          <td><b>${o.name}</b>${star}<br><span style="color:var(--ink-3);font-size:11px;">${o.address}</span></td>
          <td style="width:48px;" class="mono">${o.boxes}박스</td>
          <td style="width:64px;"><span class="pill ${sc}" style="font-size:11px;">${sl}</span></td>
          <td style="width:44px;" class="mono">${o.deliveredTime || ''}</td>
        </tr>`;
      })
      .join('');

    // 이벤트 로그
    $('log').innerHTML = s.events
      .map((e) => `<div><span class="lt">${e.time}</span><span class="${e.type}">${e.message}</span></div>`)
      .join('');

    MB.renderRoute(ctx, rd, s);
  });
})();
