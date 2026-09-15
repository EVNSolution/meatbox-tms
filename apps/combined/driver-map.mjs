import { driverMapModel } from './driver-map-model.mjs';
import { installModifierWheelZoom } from './map-wheel-zoom.mjs';

export function syncDriverMapInteractions(map, wheelZoom, editing) {
  if (!map) return;
  for (const control of [map.scrollZoom, map.boxZoom, map.doubleClickZoom, map.touchZoomRotate]) editing ? control.disable() : control.enable();
  wheelZoom?.setEnabled(!editing);
  map.touchZoomRotate.disableRotation();
}

export function mountDriverMap(element, onSelect) {
  let map, routeData, current, rendered = '', viewSignature = '', markers = [], failed = false, wheelZoom;
  const empty = document.createElement('p');
  empty.className = 'dv-map-empty';
  empty.textContent = '지도를 불러오고 있습니다.';
  element.append(empty);
  const canvas = document.createElement('div');
  canvas.className = 'dv-map-canvas';
  element.prepend(canvas);

  function render(force = false) {
    if (!current || !routeData || !map?.isStyleLoaded() || !element.offsetHeight) return;
    const key = JSON.stringify([current.deliveries.map(stop => [stop.id, stop.status]), current.dwelling]);
    if (!force && key === rendered) return;
    rendered = key;
    const model = driverMapModel(routeData, current.deliveries, current.dwelling);
    empty.hidden = Boolean(model.points.length);
    empty.textContent = '위치 정보가 등록되면 지도를 표시합니다.';
    canvas.hidden = !model.points.length;
    map.resize();
    markers.forEach(marker => marker.remove());
    markers = [];
    if (map.getSource('driver-road')) map.getSource('driver-road').setData(model.road);
    else {
      map.addSource('driver-road', { type: 'geojson', data: model.road });
      const layout = { 'line-cap': 'round', 'line-join': 'round' };
      map.addLayer({ id: 'driver-road-outline', type: 'line', source: 'driver-road', layout, paint: { 'line-color': '#fff', 'line-width': 7 } });
      map.addLayer({ id: 'driver-road', type: 'line', source: 'driver-road', layout, paint: { 'line-color': ['case', ['==', ['get', 'status'], 'done'], '#98a2b3', '#e60028'], 'line-width': 4 } });
    }
    model.points.forEach(stop => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'dv-map-pin';
      pin.dataset.status = stop.status;
      pin.innerHTML = '<svg viewBox="0 0 40 52" aria-hidden="true"><path d="M20 50C20 50 4 31.5 4 18C4 9.16 11.16 2 20 2s16 7.16 16 16c0 13.5-16 32-16 32Z" fill="currentColor" stroke="#fff" stroke-linejoin="round" stroke-width="3.2"/></svg>';
      const number = document.createElement('span'); number.textContent = stop.sequence; pin.append(number);
      pin.setAttribute('aria-label', `${stop.sequence}번째 배송지 ${stop.name}`);
      pin.addEventListener('click', () => onSelect(stop.id));
      markers.push(new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat(stop.coordinate).addTo(map));
    });
    const depot = routeData.points?.find(point => point.id === 'MFC');
    if (model.points.length && depot && Number.isFinite(depot.lng) && Number.isFinite(depot.lat) && Math.abs(depot.lng) <= 180 && Math.abs(depot.lat) <= 90) {
      const pin = document.createElement('img');
      pin.src = new URL('./assets/maps/driver-depot-pin.svg', import.meta.url).href;
      pin.alt = '출발 물류센터'; pin.setAttribute('aria-label', '출발 물류센터'); pin.width = 20; pin.height = 26;
      markers.push(new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat([depot.lng, depot.lat]).addTo(map));
    }
    if (model.vehicle) {
      const truck = document.createElement('div');
      truck.className = 'dv-map-truck';
      truck.setAttribute('aria-label', '예시 차량 위치');
      markers.push(new maplibregl.Marker({ element: truck }).setLngLat(model.vehicle).addTo(map));
    }
    const coordinates = [...model.points.map(point => point.coordinate), ...model.road.features.flatMap(feature => feature.geometry.coordinates)];
    const nextViewSignature = JSON.stringify([model.points.map(point => [point.id, point.coordinate]), model.road.features.map(feature => {
      const line = feature.geometry.coordinates;
      return [line.length, line[0], line.at(-1)];
    })]);
    if (!coordinates.length) viewSignature = '';
    else if (nextViewSignature !== viewSignature) {
      viewSignature = nextViewSignature;
      const bounds = coordinates.reduce((bounds, point) => bounds.extend(point), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
      map.fitBounds(bounds, { padding: { top: 45, bottom: 32, left: 30, right: 30 }, maxZoom: 15, duration: 0 });
    }
  }
  async function load() {
    try {
      const response = await fetch('/scenario/api/route-data');
      if (!response.ok) throw new Error('route data unavailable');
      routeData = await response.json();
      maplibregl.setWorkerUrl(new URL('./assets/vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href);
      map = new maplibregl.Map({ container: canvas, style: new URL('./assets/maps/dsv-korea-v1.json', import.meta.url).href, center: [127.1, 37.5], zoom: 11, attributionControl: false, dragRotate: false, touchPitch: false, maxPitch: 0 });
      wheelZoom = installModifierWheelZoom(map);
      syncDriverMapInteractions(map, wheelZoom, current?.editing);
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.AttributionControl({ compact: true }));
      const attribution = canvas.querySelector('.maplibregl-ctrl-attrib');
      const collapse = () => {
        if (!attribution.classList.contains('maplibregl-compact-show')) return;
        observer.disconnect(); attribution.querySelector('summary').click();
      };
      const observer = new MutationObserver(collapse);
      observer.observe(attribution, { attributes: true, attributeFilter: ['class'] });
      collapse();
      map.once('remove', () => observer.disconnect());
      map.once('load', () => render(true));
      map.on('error', () => {
        if (!map.isStyleLoaded()) { empty.hidden = false; empty.textContent = '지도를 불러오지 못했습니다. 새로고침해 주세요.'; }
      });
    } catch {
      failed = true; empty.hidden = false; empty.textContent = '지도를 불러오지 못했습니다. 새로고침해 주세요.';
    }
  }
  return {
    update(deliveries, dwelling, editing = false) {
      current = { deliveries, dwelling, editing };
      if (!map && !routeData && !failed) { routeData = {}; void load(); }
      syncDriverMapInteractions(map, wheelZoom, editing);
      render();
    },
    resize() { render(true); },
  };
}
