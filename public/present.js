(() => {
  const $ = (id) => document.getElementById(id);

  $('start').addEventListener('click', () => MB.send('advance'));
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

    const start = $('start');
    if (s.nextStep) {
      start.disabled = false;
      start.textContent = `▶ 다음 단계: ${s.nextStep.label}`;
    } else if (s.phase === 'delivering') {
      start.disabled = true;
      start.textContent = '🚚 배송 진행 중 (차량 자동 주행)';
    } else if (s.phase === 'done') {
      start.disabled = true;
      start.textContent = '금일 배송 완료';
    }
    $('traffic').disabled = s.phase !== 'delivering' || s.incidents.length > 0;
    $('dwell').disabled = s.phase !== 'delivering';
    for (const b of $('speed').querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.v) === s.speed);
    }

    $('p-done').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}`;
    $('p-boxes').textContent = `${s.kpi.boxesTotal - s.kpi.boxesDelivered}`;
    $('p-eta').textContent = s.kpi.finishEta || '—';

    $('log').innerHTML = s.events
      .slice(0, 7)
      .map((e) => `<div><span class="lt">${e.time}</span><span>${e.message}</span></div>`)
      .join('');
  });
})();
