// 공통: WebSocket 연결, 포맷터, Leaflet 경로 렌더링
window.MB = (() => {
  let ws = null;
  let onStateCb = null;
  let bootId = null;

  function connect(onState) {
    onStateCb = onState;
    open();
  }

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      // 서버가 재배포/재시작되면 열린 화면을 자동 새로고침 (구버전 코드로 신버전 상태를 읽는 사고 방지)
      if (msg.boot) {
        if (bootId && bootId !== msg.boot) { location.reload(); return; }
        bootId = msg.boot;
      }
      if (msg.type === 'state' && onStateCb) onStateCb(msg.state);
    };
    ws.onclose = () => setTimeout(open, 1500);
  }

  function send(type, extra = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...extra }));
  }

  const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);

  async function loadRouteData() {
    const res = await fetch('/api/route-data');
    return res.json();
  }

  function initMap(el, opts = {}) {
    const map = L.map(el, { zoomControl: false, attributionControl: false, ...opts });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    L.control.attribution({ prefix: false }).addAttribution('© OpenStreetMap').addTo(map);
    return {
      map,
      routeLayer: L.layerGroup().addTo(map),
      truckMarker: null,
      key: null,
      fitted: false,
    };
  }

  // 경로/정차지/차량을 그린다. 순서·상태가 바뀔 때만 폴리라인을 다시 그림.
  function renderRoute(ctx, rd, state, { showAll = true } = {}) {
    const active = state.order.filter((s) => s.status !== 'skipped');
    const seq = ['MFC', ...active.map((s) => s.id)];
    const key = state.order.map((s) => s.id + s.status[0]).join('') + '|' + state.truck.fromId + '>' + state.truck.toId;

    if (ctx.key !== key) {
      ctx.key = key;
      ctx.routeLayer.clearLayers();

      for (let i = 0; i < seq.length - 1; i++) {
        const leg = rd.legs[`${seq[i]}>${seq[i + 1]}`];
        if (!leg) continue;
        const dest = active[i];
        let style;
        if (dest.status === 'done') style = { color: '#b9bfcc', weight: 3, opacity: 0.9 };
        else if (dest.status === 'current') style = { color: '#d32f2f', weight: 5, opacity: 0.95 };
        else style = { color: '#e57373', weight: 4, opacity: 0.8, dashArray: '2 9' };
        L.polyline(leg.coords, style).addTo(ctx.routeLayer);
      }

      const mfc = rd.points.find((p) => p.id === 'MFC');
      L.marker([mfc.lat, mfc.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-mfc">가락 MFC</div>', iconSize: [58, 22], iconAnchor: [29, 11] }),
      }).addTo(ctx.routeLayer);

      state.order.forEach((stop, i) => {
        const p = rd.points.find((x) => x.id === stop.id);
        const cls = `marker-stop ${stop.status}`;
        const label = stop.status === 'done' ? '✓' : stop.status === 'skipped' ? '✕' : i + 1;
        const tip = stop.status === 'skipped' ? `${stop.name} (스킵)` : `${i + 1}. ${stop.name} (${stop.boxes}박스)`;
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({ className: '', html: `<div class="${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(ctx.routeLayer).bindTooltip(tip, { direction: 'top' });
      });
    }

    if (!ctx.truckMarker) {
      ctx.truckMarker = L.marker([state.truck.lat, state.truck.lng], {
        icon: L.divIcon({ className: '', html: '<div class="marker-truck">🚚</div>', iconSize: [38, 38], iconAnchor: [19, 19] }),
        zIndexOffset: 1000,
      }).addTo(ctx.map);
    } else {
      ctx.truckMarker.setLatLng([state.truck.lat, state.truck.lng]);
    }

    if (!ctx.fitted) {
      ctx.fitted = true;
      const pts = rd.points.map((p) => [p.lat, p.lng]);
      ctx.map.fitBounds(L.latLngBounds(pts).pad(0.12));
    }
  }

  return { connect, send, fmtM, loadRouteData, initMap, renderRoute };
})();
