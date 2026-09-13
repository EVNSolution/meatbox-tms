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
  $('p-stops').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-skip]');
    if (b) MB.send('toggle_skip', { stopId: b.dataset.skip });
  });

  const PHASE = {
    unordered: ['고객 주문 대기', 'gray'],
    idle: ['주문 접수됨', 'gray'],
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
    if (s.phase === 'unordered') {
      start.disabled = true;
      start.textContent = '🛒 고객 주문 대기 — 고객 앱에서 주문하기';
    } else if (s.nextStep) {
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

    $('p-stops').innerHTML = s.order
      .map((o, i) => {
        let act;
        if (o.id === s.customerStopId) act = '<span class="pill amber" style="font-size:10.5px;">시연 고객</span>';
        else if (o.status === 'pending') act = `<button class="btn ghost sm" data-skip="${o.id}">스킵</button>`;
        else if (o.status === 'skipped') act = `<button class="btn dark sm" data-skip="${o.id}">복원</button>`;
        else if (o.status === 'done') act = '<span class="pill green" style="font-size:10.5px;">완료</span>';
        else act = '<span class="pill red" style="font-size:10.5px;">배송 중</span>';
        return `<div class="ps-row ${o.status}">
          <span class="no">${o.status === 'done' ? '✓' : o.status === 'skipped' ? '✕' : i + 1}</span>
          <span class="nm">${o.name}</span><span class="bx">${o.boxes}박스</span>
          <span class="act">${act}</span>
        </div>`;
      })
      .join('');

    $('log').innerHTML = s.events
      .slice(0, 7)
      .map((e) => `<div><span class="lt">${e.time}</span><span>${e.message}</span></div>`)
      .join('');
  });
})();
