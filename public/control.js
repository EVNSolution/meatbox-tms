(async () => {
  const rd = await MB.loadRouteData();
  const ctx = MB.initMap(document.getElementById('map'));
  const $ = (id) => document.getElementById(id);

  const PHASE = {
    idle: ['대기', 'gray'],
    preparing: ['MFC 출고 중', 'amber'],
    delivering: ['배송 중', 'red'],
    done: ['금일 완료', 'green'],
  };
  const STATUS = { pending: ['대기', 'gray'], current: ['배송 중', 'red'], done: ['완료', 'green'] };

  let selected = 'V1';
  let lastState = null;
  const parkedLayer = L.layerGroup().addTo(ctx.map);
  const mfc = rd.points.find((p) => p.id === 'MFC');

  $('vehicles').addEventListener('click', (e) => {
    const row = e.target.closest('[data-veh]');
    if (row && row.dataset.veh !== selected) {
      selected = row.dataset.veh;
      ctx.key = null; // 지도 다시 그리기
      if (lastState) render(lastState);
    }
  });

  function vehicleStatus(v, s) {
    if (!v.live) return [v.status, v.status === '상차 중' ? 'amber' : 'gray'];
    return PHASE[s.phase];
  }

  function renderVehicles(s) {
    $('vehicles').innerHTML = s.vehicles
      .map((v) => {
        const [sl, sc] = vehicleStatus(v, s);
        return `<div class="veh-row${v.id === selected ? ' sel' : ''}" data-veh="${v.id}">
          <span class="ico">🚚</span>
          <div><div class="plate">${v.plate}</div><div class="rg">${v.driver} · ${v.region}</div></div>
          <span class="st pill ${sc}" style="font-size:11px;">${sl}</span>
        </div>`;
      })
      .join('');
  }

  function renderLive(s) {
    parkedLayer.clearLayers();
    $('k-load').textContent = `${s.kpi.boxesTotal - s.kpi.boxesDelivered}/${s.kpi.boxesTotal}박스`;
    $('k-load').nextElementSibling.textContent = '상차 적재 (적재율 100%)';
    $('k-done').textContent = `${s.kpi.stopsDone}/${s.kpi.stopsTotal}착지`;
    $('k-eta').textContent = s.kpi.finishEta || '—';
    $('incident').style.display = s.incidents.length ? 'inline-flex' : 'none';

    const header = `<tr style="color:var(--ink-3);font-size:11px;">
      <td>#</td><td>정차지</td><td>박스</td><td>상태</td><td style="text-align:right;">ETA</td>
    </tr>`;
    $('stops').innerHTML = header + s.order
      .map((o, i) => {
        const [sl, sc] = STATUS[o.status];
        const star = o.id === s.customerStopId ? ' ⭐' : '';
        let etaCell;
        if (o.status === 'done') etaCell = `<span style="color:var(--green);font-weight:700;">${o.deliveredTime} ✓</span>`;
        else if (o.status === 'current' && s.truck.dwelling) etaCell = '<span style="color:var(--amber);font-weight:700;">하차 중</span>';
        else etaCell = o.eta ? `<b>${o.eta}</b>` : '—';
        return `<tr>
          <td style="width:22px;font-weight:800;">${i + 1}</td>
          <td><b>${o.name}</b>${star}<br><span style="color:var(--ink-3);font-size:11px;">${o.address}</span></td>
          <td style="width:48px;" class="mono">${o.boxes}박스</td>
          <td style="width:60px;"><span class="pill ${sc}" style="font-size:11px;">${sl}</span></td>
          <td style="width:58px;text-align:right;" class="mono">${etaCell}</td>
        </tr>`;
      })
      .join('');

    MB.renderRoute(ctx, rd, s);
    if (ctx.truckMarker && !ctx.map.hasLayer(ctx.truckMarker)) ctx.truckMarker.addTo(ctx.map);
  }

  function renderParked(s) {
    const v = s.vehicles.find((x) => x.id === selected);
    ctx.routeLayer.clearLayers();
    if (ctx.truckMarker && ctx.map.hasLayer(ctx.truckMarker)) ctx.map.removeLayer(ctx.truckMarker);
    if (parkedLayer.getLayers().length === 0) {
      L.marker([mfc.lat, mfc.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-mfc">가락 MFC</div>', iconSize: [58, 22], iconAnchor: [29, 11] }),
      }).addTo(parkedLayer);
      L.marker([mfc.lat, mfc.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-truck" style="filter:grayscale(1);opacity:.8;">🚚</div>', iconSize: [38, 38], iconAnchor: [19, 42] }),
      }).addTo(parkedLayer);
    }

    $('k-load').textContent = `${v.planned.boxes}박스`;
    $('k-load').nextElementSibling.textContent = '금일 상차 예정';
    $('k-done').textContent = `0/${v.planned.stops}착지`;
    $('k-eta').textContent = '—';
    $('incident').style.display = 'none';

    $('stops').innerHTML = `<tr><td style="padding:14px 6px;color:var(--ink-3);">
      ${v.status} — 아직 출발 전 차량입니다.<br>
      <b style="color:var(--ink);">${v.region}</b> · 금일 계획 ${v.planned.stops}착지 · ${v.planned.boxes}박스 (기사: ${v.driver})
    </td></tr>`;
  }

  function render(s) {
    $('clock').textContent = s.simClock;
    const [pl, pc] = PHASE[s.phase];
    $('phase').textContent = pl;
    $('phase').className = `pill ${pc} phase`;
    renderVehicles(s);

    const v = s.vehicles.find((x) => x.id === selected);
    if (v && !v.live) renderParked(s);
    else renderLive(s);

    $('log').innerHTML = s.events
      .map((e) => `<div><span class="lt">${e.time}</span><span class="${e.type}">${e.message}</span></div>`)
      .join('');
  }

  MB.connect((s) => {
    lastState = s;
    render(s);
  });
})();
