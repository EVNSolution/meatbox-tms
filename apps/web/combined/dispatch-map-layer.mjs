const ids = {
  marker: 'dispatch-destination-marker',
  points: 'dispatch-orders-source',
  regions: 'dispatch-regions-source',
  regionFill: 'dispatch-regions-fill',
  regionLine: 'dispatch-regions-line',
  selectedRegion: 'dispatch-regions-selected',
  hoverShadow: 'dispatch-regions-hover-shadow',
  hoverFill: 'dispatch-regions-hover-fill',
  hoverLine: 'dispatch-regions-hover-line',
  allPoints: 'dispatch-orders-all',
  groupPoints: 'dispatch-orders-group',
  orderPoint: 'dispatch-order-selected',
  multiSelect: 'dispatch-orders-multi',
  zonePins: 'dispatch-zone-pins-source',
  zonePinLayer: 'dispatch-zone-pins',
  zonePinSelected: 'dispatch-zone-pin-selected',
};

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const nothing = ['==', ['literal', 1], ['literal', 0]];
const hasOrders = ['>', ['get', 'orderCount'], 0];
const equals = (property, value) => typeof value === 'string' && value
  ? ['==', ['get', property], value]
  : nothing;
// The hovered zone rises off the map: an opaque fill and outline shifted up-left, over a soft
// shadow shifted down-right. Translations are in screen pixels, so the lift looks the same at every zoom.
const lifted = [-2, -3];
const shadowOffset = [4, 6];
const liftTransition = { duration: 160, delay: 0 };
const includes = (property, values) => Array.isArray(values) && values.length
  ? ['in', ['get', property], ['literal', values]]
  : nothing;

function loadMarkerImage() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      try {
        await image.decode?.();
        resolve(image);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error('배차 지도 마커 이미지를 불러오지 못했습니다.'));
    image.src = '/combined/assets/maps/dsv-destination-marker.svg';
  });
}

function addLayers(map, markerImage, ownedLayers, ownedSources) {
  const addSource = (id, definition) => {
    const existed = Boolean(map.getSource(id));
    map.addSource(id, definition);
    if (!existed && map.getSource(id)) ownedSources.add(id);
  };
  const addLayer = layer => {
    const existed = Boolean(map.getLayer(layer.id));
    map.addLayer(layer);
    if (!existed && map.getLayer(layer.id)) ownedLayers.add(layer.id);
  };
  if (!map.hasImage(ids.marker)) map.addImage(ids.marker, markerImage);
  addSource(ids.regions, { type: 'geojson', data: emptyCollection() });
  addLayer({ id: ids.regionFill, type: 'fill', source: ids.regions, filter: hasOrders, paint: { 'fill-color': '#218662', 'fill-opacity': 0.18 } });
  addLayer({ id: ids.regionLine, type: 'line', source: ids.regions, minzoom: 11, filter: hasOrders, paint: { 'line-color': '#3c705a', 'line-opacity': 0.7, 'line-width': 1.2 } });
  addLayer({ id: ids.selectedRegion, type: 'line', source: ids.regions, minzoom: 11, filter: nothing, paint: { 'line-color': '#1e5142', 'line-opacity': 0.95, 'line-width': 3 } });
  addLayer({ id: ids.hoverShadow, type: 'fill', source: ids.regions, filter: nothing, paint: { 'fill-color': '#0d2b20', 'fill-opacity': 0.28, 'fill-translate': shadowOffset, 'fill-antialias': false } });
  addLayer({ id: ids.hoverFill, type: 'fill', source: ids.regions, filter: nothing, paint: { 'fill-color': '#e4f2eb', 'fill-opacity': 1, 'fill-translate': lifted } });
  addLayer({ id: ids.hoverLine, type: 'line', source: ids.regions, filter: nothing, paint: { 'line-color': '#1e5142', 'line-width': 2.5, 'line-translate': lifted } });

  addSource(ids.points, { type: 'geojson', data: emptyCollection() });
  addLayer({
    id: ids.multiSelect, type: 'circle', source: ids.points, filter: nothing,
    paint: { 'circle-radius': 17, 'circle-color': '#2563eb', 'circle-opacity': 0.3, 'circle-stroke-width': 2, 'circle-stroke-color': '#1d4ed8', 'circle-translate': [0, -12] },
  });
  addLayer({
    id: ids.allPoints, type: 'symbol', source: ids.points,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.42, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 1, 'icon-opacity-transition': { duration: 0, delay: 0 } },
  });
  addLayer({
    id: ids.groupPoints, type: 'symbol', source: ids.points, filter: nothing,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.62, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  addLayer({
    id: ids.orderPoint, type: 'symbol', source: ids.points, filter: nothing,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.76, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  addSource(ids.zonePins, { type: 'geojson', data: emptyCollection() });
  addLayer({
    id: ids.zonePinLayer, type: 'symbol', source: ids.zonePins,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.55, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  addLayer({
    id: ids.zonePinSelected, type: 'symbol', source: ids.zonePins, filter: nothing,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.8, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
}

export function mountDispatchMapLayers(map, { onPick = () => {}, onZonePick = () => {}, onZoneHover = () => {}, onError = () => {} } = {}) {
  let destroyed = false;
  let ready = false;
  let loading = false;
  let addedImage = false;
  const ownedLayers = new Set();
  const ownedSources = new Set();
  let pointData = null;
  let regionData = null;
  let hoveredZoneId = null;
  let zonePinData = null;
  let latest = {
    points: emptyCollection(), regions: null, selectedGroupId: null,
    selectedOrderId: null, selectedOrderIds: [], selectedZoneIds: [], zonePins: emptyCollection(), mode: 'regions',
  };

  const removeResources = () => {
    const layerIds = [ids.zonePinSelected, ids.zonePinLayer, ids.orderPoint, ids.groupPoints, ids.allPoints, ids.multiSelect, ids.hoverLine, ids.hoverFill, ids.hoverShadow, ids.selectedRegion, ids.regionLine, ids.regionFill];
    for (const id of layerIds) if (ownedLayers.has(id) && map.getLayer(id)) map.removeLayer(id);
    for (const id of [ids.zonePins, ids.points, ids.regions]) if (ownedSources.has(id) && map.getSource(id)) map.removeSource(id);
    ownedLayers.clear();
    ownedSources.clear();
    if (addedImage && map.hasImage(ids.marker)) map.removeImage(ids.marker);
  };

  const apply = () => {
    if (!ready || destroyed) return;
    if (pointData !== latest.points) {
      pointData = latest.points;
      map.getSource(ids.points).setData(pointData || emptyCollection());
    }
    if (regionData !== latest.regions) {
      regionData = latest.regions;
      map.getSource(ids.regions).setData(regionData || emptyCollection());
    }
    if (zonePinData !== latest.zonePins) {
      zonePinData = latest.zonePins;
      map.getSource(ids.zonePins).setData(zonePinData || emptyCollection());
    }
    const groupFilter = equals('groupId', latest.selectedGroupId);
    const orderFilter = equals('orderId', latest.selectedOrderId);
    map.setFilter(ids.groupPoints, groupFilter);
    map.setFilter(ids.orderPoint, orderFilter);
    map.setFilter(ids.multiSelect, includes('orderId', latest.selectedOrderIds));
    map.setFilter(ids.zonePinSelected, equals('orderId', latest.selectedOrderId));
    map.setPaintProperty(ids.allPoints, 'icon-opacity', latest.selectedGroupId ? 0.5 : 1);
    map.setFilter(ids.selectedRegion, includes('zoneId', latest.selectedZoneIds));
    const regionVisibility = latest.mode === 'regions' ? 'visible' : 'none';
    if (latest.mode !== 'regions' && hoveredZoneId) hover(null);
    const pointVisibility = latest.mode === 'orders' ? 'visible' : 'none';
    for (const id of [ids.regionFill, ids.regionLine, ids.selectedRegion, ids.hoverShadow, ids.hoverFill, ids.hoverLine]) map.setLayoutProperty(id, 'visibility', regionVisibility);
    for (const id of [ids.allPoints, ids.groupPoints, ids.orderPoint, ids.multiSelect]) map.setLayoutProperty(id, 'visibility', pointVisibility);
    for (const id of [ids.zonePinLayer, ids.zonePinSelected]) map.setLayoutProperty(id, 'visibility', regionVisibility);
  };

  const start = () => {
    if (destroyed || ready || loading) return;
    loading = true;
    loadMarkerImage().then(image => {
      if (destroyed) return;
      addedImage = !map.hasImage(ids.marker);
      const setupErrors = [];
      const captureSetupError = event => setupErrors.push(event?.error || new Error('배차 지도 레이어를 생성하지 못했습니다.'));
      map.on('error', captureSetupError);
      try {
        addLayers(map, image, ownedLayers, ownedSources);
      } finally {
        map.off('error', captureSetupError);
      }
      const requiredLayers = [ids.regionFill, ids.regionLine, ids.selectedRegion, ids.hoverShadow, ids.hoverFill, ids.hoverLine, ids.multiSelect, ids.allPoints, ids.groupPoints, ids.orderPoint, ids.zonePinLayer, ids.zonePinSelected];
      if (setupErrors.length || requiredLayers.some(id => !map.getLayer(id))) {
        removeResources();
        throw setupErrors[0] || new Error('배차 지도 레이어를 생성하지 못했습니다.');
      }
      ready = true;
      apply();
    }).catch(error => {
      if (!destroyed) onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { loading = false; });
  };

  const pointLayers = [ids.orderPoint, ids.groupPoints, ids.allPoints];
  const pinsAt = point => [...new Set(map.queryRenderedFeatures([[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]], { layers: [ids.zonePinSelected, ids.zonePinLayer] })
    .map(feature => feature?.properties?.orderId).filter(value => typeof value === 'string' && value))];
  const zoneAt = point => map.queryRenderedFeatures([point.x, point.y], { layers: [ids.regionFill] })
    .map(feature => feature?.properties?.zoneId).find(value => typeof value === 'string' && value) || null;
  const setPaint = (id, property, value, transition) => {
    map.setPaintProperty(id, `${property}-transition`, transition);
    map.setPaintProperty(id, property, value);
  };
  const hover = (zoneId, point) => {
    if (zoneId !== hoveredZoneId) {
      hoveredZoneId = zoneId;
      const filter = equals('zoneId', zoneId);
      for (const id of [ids.hoverShadow, ids.hoverFill, ids.hoverLine]) map.setFilter(id, filter);
      if (zoneId) {
        // Start flat, then rise on the next frame so each newly hovered zone animates its lift.
        const instant = { duration: 0, delay: 0 };
        setPaint(ids.hoverShadow, 'fill-translate', [0, 0], instant);
        setPaint(ids.hoverFill, 'fill-translate', [0, 0], instant);
        setPaint(ids.hoverLine, 'line-translate', [0, 0], instant);
        (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 16)))(() => {
          if (destroyed || hoveredZoneId !== zoneId) return;
          setPaint(ids.hoverShadow, 'fill-translate', shadowOffset, liftTransition);
          setPaint(ids.hoverFill, 'fill-translate', lifted, liftTransition);
          setPaint(ids.hoverLine, 'line-translate', lifted, liftTransition);
        });
      }
      const canvas = map.getCanvas?.();
      if (canvas) canvas.style.cursor = zoneId ? 'pointer' : '';
    }
    onZoneHover(zoneId ? { zoneId, point } : null);
  };
  const mousemove = event => {
    if (!ready || destroyed || latest.mode !== 'regions') return;
    const point = event?.point || { x: 0, y: 0 };
    // A pin under the cursor wins: its own popup carries the order detail.
    hover(pinsAt(point).length ? null : zoneAt(point), point);
  };
  const mouseout = () => { if (ready && !destroyed) hover(null); };
  const zoneClick = event => {
    const point = event?.point || { x: 0, y: 0 };
    const pins = pinsAt(point);
    if (pins.length) { onPick(pins); return; }
    const zone = zoneAt(point);
    // Touch has no hover, so a tap shows the same lifted zone and info.
    hover(zone, point);
    onZonePick(zone);
  };
  const click = event => {
    if (!ready || destroyed) return;
    if (latest.mode === 'regions') { zoneClick(event); return; }
    if (latest.mode !== 'orders') return;
    const point = event?.point || { x: 0, y: 0 };
    const box = [[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]];
    const features = map.queryRenderedFeatures(box, { layers: pointLayers });
    const orderIds = [...new Set(features.map(feature => feature?.properties?.orderId).filter(value => typeof value === 'string' && value))]
      .sort((left, right) => {
        const rank = id => id === latest.selectedOrderId ? 0
          : features.some(feature => feature?.properties?.orderId === id && feature?.properties?.groupId === latest.selectedGroupId) ? 1 : 2;
        return rank(left) - rank(right);
      });
    onPick(orderIds);
  };

  map.on('style.load', start);
  map.on('click', click);
  map.on('mousemove', mousemove);
  map.on('mouseout', mouseout);
  if (map.isStyleLoaded?.()) queueMicrotask(start);

  return {
    update(next = {}) {
      latest = { ...latest, ...next };
      apply();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      map.off('style.load', start);
      map.off('click', click);
      map.off('mousemove', mousemove);
      map.off('mouseout', mouseout);
      removeResources();
    },
  };
}
