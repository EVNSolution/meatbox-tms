const ids = {
  marker: 'dispatch-destination-marker',
  points: 'dispatch-orders-source',
  regions: 'dispatch-regions-source',
  regionFill: 'dispatch-regions-fill',
  regionLine: 'dispatch-regions-line',
  selectedRegion: 'dispatch-regions-selected',
  allPoints: 'dispatch-orders-all',
  groupPoints: 'dispatch-orders-group',
  orderPoint: 'dispatch-order-selected',
};

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const nothing = ['==', ['literal', 1], ['literal', 0]];
const equals = (property, value) => typeof value === 'string' && value
  ? ['==', ['get', property], value]
  : nothing;
const includes = (property, values) => Array.isArray(values) && values.length
  ? ['in', ['get', property], ['literal', values]]
  : nothing;

// Choose once in geographic space so panning cannot swap visible orders.
export function stableMarkerVisibility(data) {
  const entries = data.features.map(feature => {
    const [lng, lat] = feature.geometry.coordinates;
    const sin = Math.sin(Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI / 180);
    return { feature, x: (lng + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI), zoom: 14 };
  });
  const ordered = [...entries].sort((a, b) => String(a.feature.properties.orderId).localeCompare(String(b.feature.properties.orderId)));
  for (let zoom = 5; zoom < 14; zoom++) {
    const scale = 512 * 2 ** zoom / 48;
    const cell = entry => `${Math.floor(entry.x * scale)},${Math.floor(entry.y * scale)}`;
    const occupied = new Set(ordered.filter(entry => entry.zoom < zoom).map(cell));
    for (const entry of ordered) {
      if (entry.zoom < zoom || occupied.has(cell(entry))) continue;
      occupied.add(cell(entry));
      entry.zoom = zoom;
    }
  }
  return { ...data, features: entries.map(({ feature, zoom }) => ({ ...feature, properties: { ...feature.properties, visibleFromZoom: zoom } })) };
}

function markerOpacity(opacity) {
  const visibleAt = zoom => ['case', ['<=', ['get', 'visibleFromZoom'], zoom], opacity, 0];
  const expression = ['step', ['zoom'], visibleAt(5)];
  for (let zoom = 6; zoom <= 14; zoom++) expression.push(zoom, visibleAt(zoom));
  return expression;
}
const normalOpacity = markerOpacity(1);
const subduedOpacity = markerOpacity(0.5);

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
    image.src = new URL('./assets/maps/dsv-destination-marker.svg', import.meta.url).href;
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
  addLayer({ id: ids.regionFill, type: 'fill', source: ids.regions, paint: { 'fill-color': '#697d74', 'fill-opacity': 0.09 } });
  addLayer({ id: ids.regionLine, type: 'line', source: ids.regions, paint: { 'line-color': '#65736d', 'line-opacity': 0.58, 'line-width': 1.2 } });
  addLayer({ id: ids.selectedRegion, type: 'line', source: ids.regions, filter: nothing, paint: { 'line-color': '#1e5142', 'line-opacity': 0.95, 'line-width': 3 } });

  addSource(ids.points, { type: 'geojson', data: emptyCollection() });
  addLayer({
    id: ids.allPoints, type: 'symbol', source: ids.points,
    layout: {
      'icon-image': ids.marker, 'icon-size': 0.42, 'icon-anchor': 'bottom',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': normalOpacity, 'icon-opacity-transition': { duration: 0, delay: 0 } },
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
      'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.15],
      'text-anchor': 'top', 'text-allow-overlap': true, 'text-ignore-placement': true,
    },
    paint: { 'text-color': '#102f26', 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 },
  });
}

export function mountDispatchMapLayers(map, { onPick = () => {}, onError = () => {} } = {}) {
  let destroyed = false;
  let ready = false;
  let loading = false;
  let addedImage = false;
  const ownedLayers = new Set();
  const ownedSources = new Set();
  let pointData = null;
  let regionData = null;
  let latest = {
    points: emptyCollection(), regions: null, selectedGroupId: null,
    selectedOrderId: null, selectedZoneIds: [], showRegions: false, showAllPins: false,
  };

  const removeResources = () => {
    const layerIds = [ids.orderPoint, ids.groupPoints, ids.allPoints, ids.selectedRegion, ids.regionLine, ids.regionFill];
    for (const id of layerIds) if (ownedLayers.has(id) && map.getLayer(id)) map.removeLayer(id);
    for (const id of [ids.points, ids.regions]) if (ownedSources.has(id) && map.getSource(id)) map.removeSource(id);
    ownedLayers.clear();
    ownedSources.clear();
    if (addedImage && map.hasImage(ids.marker)) map.removeImage(ids.marker);
  };

  const apply = () => {
    if (!ready || destroyed) return;
    if (pointData !== latest.points) {
      pointData = latest.points;
      map.getSource(ids.points).setData(stableMarkerVisibility(pointData || emptyCollection()));
    }
    if (regionData !== latest.regions) {
      regionData = latest.regions;
      map.getSource(ids.regions).setData(regionData || emptyCollection());
    }
    const groupFilter = equals('groupId', latest.selectedGroupId);
    const orderFilter = equals('orderId', latest.selectedOrderId);
    map.setFilter(ids.groupPoints, groupFilter);
    map.setFilter(ids.orderPoint, orderFilter);
    const opacity = latest.showAllPins
      ? latest.selectedGroupId ? 0.5 : 1
      : latest.selectedGroupId ? subduedOpacity : normalOpacity;
    map.setPaintProperty(ids.allPoints, 'icon-opacity', opacity);
    map.setFilter(ids.selectedRegion, includes('zoneId', latest.selectedZoneIds));
    const visibility = latest.showRegions ? 'visible' : 'none';
    for (const id of [ids.regionFill, ids.regionLine, ids.selectedRegion]) map.setLayoutProperty(id, 'visibility', visibility);
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
      const requiredLayers = [ids.regionFill, ids.regionLine, ids.selectedRegion, ids.allPoints, ids.groupPoints, ids.orderPoint];
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
  const regionLayers = [ids.selectedRegion, ids.regionFill];
  const click = event => {
    if (!ready || destroyed) return;
    const point = event?.point || { x: 0, y: 0 };
    const box = [[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]];
    const features = map.queryRenderedFeatures(box, { layers: pointLayers }).filter(feature => {
      const visibleFrom = Number(feature.properties?.visibleFromZoom ?? 5);
      return latest.showAllPins || feature.layer?.id !== ids.allPoints || visibleFrom === 5 || map.getZoom() >= visibleFrom;
    });
    const orderIds = [...new Set(features.map(feature => feature?.properties?.orderId).filter(value => typeof value === 'string' && value))]
      .sort((left, right) => {
        const rank = id => id === latest.selectedOrderId ? 0
          : features.some(feature => feature?.properties?.orderId === id && feature?.properties?.groupId === latest.selectedGroupId) ? 1 : 2;
        return rank(left) - rank(right);
      });
    if (orderIds.length) { onPick(orderIds); return; }
    if (!latest.showRegions) return;
    const zones = map.queryRenderedFeatures(box, { layers: regionLayers });
    const zoneId = zones.map(feature => feature?.properties?.zoneId)
      .find(value => typeof value === 'string' && value);
    if (zoneId) onPick([], { zoneId });
  };

  map.on('style.load', start);
  map.on('click', click);
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
      removeResources();
    },
  };
}
