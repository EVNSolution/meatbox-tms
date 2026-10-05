const boxesText = boxes => Number.isFinite(boxes) && boxes >= 0 ? `${boxes.toLocaleString('ko-KR')}박스` : '미확인';

export function orderMapModel(deliveries, routeData) {
  const points = new Map((routeData?.points || []).filter(point =>
    typeof point?.id === 'string' && Number.isFinite(point.lng) && Number.isFinite(point.lat)
    && Math.abs(point.lng) <= 180 && Math.abs(point.lat) <= 90
  ).map(point => [point.id, [point.lng, point.lat]]));
  const mapped = (deliveries || []).flatMap(delivery => points.has(delivery.id) ? [{ delivery, coordinates: points.get(delivery.id) }] : []);
  return { mapped, unknownCount: Math.max(0, (deliveries?.length || 0) - mapped.length) };
}

export function createOrderMap(element) {
  maplibregl.setWorkerUrl('/combined/assets/vendor/maplibre/maplibre-gl-csp-worker.js');
  const map = new maplibregl.Map({
    container: element,
    style: '/combined/assets/maps/dsv-korea-v1.json',
    center: [126.995, 37.43], zoom: 10.35,
    maxBounds: [124.5, 33, 132, 39.5],
    attributionControl: false, scrollZoom: true,
    dragRotate: false, touchPitch: false, pitchWithRotate: false, maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  const attribution = element.querySelector('.maplibregl-ctrl-attrib');
  if (attribution) {
    const collapse = () => {
      if (!attribution.classList.contains('maplibregl-compact-show')) return;
      observer.disconnect();
      attribution.querySelector('summary')?.click();
    };
    const observer = new MutationObserver(collapse);
    observer.observe(attribution, { attributes: true, attributeFilter: ['class'] });
    collapse();
    map.once('remove', () => observer.disconnect());
  }
  return map;
}

export function createOrderMarker(map, delivery, coordinates) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'order-map-marker';
  element.dataset.orderMarker = delivery.id;
  element.dataset.orderLabel = Number.isFinite(delivery.sequence) ? String(delivery.sequence) : (delivery.name || '배송지 미등록');
  element.setAttribute('aria-label', `${delivery.name || '배송지 미등록'} ${boxesText(delivery.boxes)} 선택`);
  const marker = new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat(coordinates).addTo(map);
  return { element, remove: () => marker.remove() };
}

