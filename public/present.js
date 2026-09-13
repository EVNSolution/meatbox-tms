(() => {
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

  MB.connect((s) => {
    $('clock').textContent = s.simClock;
    const [pl, pc] = PHASE[s.phase];
    $('phase').textContent = pl;
    $('phase').className = `pill ${pc}`;
    $('incident').style.display = s.incidents.length ? 'inline-flex' : 'none';

    $('start').disabled = s.phase !== 'idle';
    $('start').textContent = s.phase === 'idle' ? '▶ 시나리오 시작' : s.phase === 'done' ? '금일 배송 완료' : '▶ 진행 중…';
    $('traffic').disabled = s.phase !== 'delivering' || s.incidents.length > 0;
    $('dwell').disabled = s.phase !== 'delivering';
    for (const b of $('speed').querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.v) === s.speed);
    }

    $('p-done').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}`;
    $('p-boxes').textContent = `${s.kpi.boxesTotal - s.kpi.boxesDelivered}`;
    const cust = s.order.find((o) => o.id === s.customerStopId);
    $('p-eta').textContent = s.eta
      ? `${s.eta.startText}~${s.eta.endText}`
      : cust?.deliveredTime ? `${cust.deliveredTime} 완료` : '—';

    $('log').innerHTML = s.events
      .slice(0, 7)
      .map((e) => `<div><span class="lt">${e.time}</span><span>${e.message}</span></div>`)
      .join('');
  });
})();
