import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDispatchMapLayers } from './dispatch-map-layer.mjs';

class FakeImage {
  set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); }
  decode() { return Promise.resolve(); }
}
globalThis.Image = FakeImage;

class FakeMap {
  constructor({ loaded = true } = {}) {
    this.loaded = loaded;
    this.listeners = new Map();
    this.sources = new Map();
    this.layers = new Map();
    this.layerOrder = [];
    this.images = new Map();
    this.filters = new Map();
    this.visibility = new Map();
    this.queries = [];
  }
  on(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  off(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  isStyleLoaded() { return this.loaded; }
  hasImage(id) { return this.images.has(id); }
  addImage(id, image) { this.images.set(id, image); }
  removeImage(id) { this.images.delete(id); }
  addSource(id, definition) {
    this.sources.set(id, { definition, data: definition.data, setDataCalls: 0, setData(data) { this.data = data; this.setDataCalls += 1; } });
  }
  getSource(id) { return this.sources.get(id); }
  removeSource(id) { this.sources.delete(id); }
  addLayer(layer) { this.layers.set(layer.id, layer); this.layerOrder.push(layer.id); }
  getLayer(id) { return this.layers.get(id); }
  removeLayer(id) { this.layers.delete(id); this.layerOrder = this.layerOrder.filter(value => value !== id); }
  setFilter(id, filter) { this.filters.set(id, filter); }
  setPaintProperty(id, property, value) { this.layers.get(id).paint[property] = value; }
  setLayoutProperty(id, property, value) { this.visibility.set(`${id}:${property}`, value); }
  queryRenderedFeatures(box, options) { this.lastBox = box; this.lastQueryLayers = options.layers; return this.queries.shift() || []; }
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const points = count => ({
  type: 'FeatureCollection',
  features: Array.from({ length: count }, (_, index) => ({
    type: 'Feature', id: `O${index}`, properties: { orderId: `O${index}`, groupId: `G${index % 3}` },
    geometry: { type: 'Point', coordinates: [126.9 + index / 100000, 37.4 + index / 100000] },
  })),
});
const regions = () => ({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { zoneId: 'Z1', orderCount: 3 }, geometry: { type: 'Polygon', coordinates: [[[127, 37], [127.1, 37], [127.1, 37.1], [127, 37]]] } },
  { type: 'Feature', properties: { zoneId: 'Z2', orderCount: 0 }, geometry: { type: 'Polygon', coordinates: [[[128, 37], [128.1, 37], [128.1, 37.1], [128, 37]]] } },
] });

test('권역 보기는 주문 핀을 숨기고 줌 11부터 주문이 있는 권역의 중앙 숫자를 표시한다', async () => {
  const map = new FakeMap({ loaded: false });
  const orders = points(5000), zones = regions();
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: orders, regions: zones, mode: 'regions' });
  assert.equal(map.sources.size, 0);
  map.fire('style.load');
  await flush();
  assert.equal(map.getSource('dispatch-orders-source').data.features.length, 5000);
  assert.deepEqual(map.getSource('dispatch-orders-source').data.features.map(feature => feature.geometry), orders.features.map(feature => feature.geometry));
  assert.equal(map.getSource('dispatch-regions-source').data, zones);
  assert.ok([...map.sources.values()].every(source => !source.definition.cluster));
  const labels = map.getLayer('dispatch-regions-counts');
  assert.equal(labels.source, 'dispatch-regions-source');
  assert.equal(labels.minzoom, 11);
  assert.deepEqual(labels.filter, ['>', ['get', 'orderCount'], 0]);
  assert.deepEqual(labels.layout['text-field'], ['to-string', ['get', 'orderCount']]);
  assert.equal(labels.layout['symbol-placement'], 'point');
  assert.equal(map.visibility.get('dispatch-regions-counts:visibility'), 'visible');
  assert.equal(map.visibility.get('dispatch-orders-all:visibility'), 'none');
  assert.ok(map.layerOrder.indexOf('dispatch-regions-counts') < map.layerOrder.indexOf('dispatch-orders-all'));
  mounted.destroy();
});

test('주문 보기에서는 모든 핀을 줌과 관계없이 표시하며 선택 필터만 갱신한다', async () => {
  const map = new FakeMap();
  const orders = points(5000), zones = regions();
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: orders, regions: zones, mode: 'orders', selectedGroupId: 'G1', selectedOrderId: 'O10' });
  await flush();
  const source = map.getSource('dispatch-orders-source');
  assert.equal(source.setDataCalls, 1);
  assert.equal(map.visibility.get('dispatch-orders-all:visibility'), 'visible');
  assert.equal(map.visibility.get('dispatch-regions-counts:visibility'), 'none');
  assert.equal(map.getLayer('dispatch-orders-all').paint['icon-opacity'], 0.5);
  assert.equal(map.getLayer('dispatch-orders-all').layout['icon-allow-overlap'], true);
  assert.equal(map.getLayer('dispatch-orders-all').minzoom, undefined);
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['get', 'groupId'], 'G1']);
  assert.deepEqual(map.filters.get('dispatch-order-selected'), ['==', ['get', 'orderId'], 'O10']);
  mounted.update({ mode: 'regions', selectedGroupId: null, selectedOrderId: null });
  assert.equal(source.setDataCalls, 1, '보기 전환은 주문 좌표를 다시 싣지 않는다');
  assert.equal(map.getSource('dispatch-regions-source').setDataCalls, 1);
  mounted.update({ mode: 'orders' });
  assert.equal(map.getLayer('dispatch-orders-all').paint['icon-opacity'], 1);
  assert.equal(map.visibility.get('dispatch-orders-all:visibility'), 'visible');
  mounted.destroy();
});

test('주문 보기의 겹친 핀만 선택하고 권역 보기에서는 주문 선택을 바꾸지 않는다', async () => {
  const map = new FakeMap();
  const picked = [];
  const mounted = mountDispatchMapLayers(map, { onPick: ids => picked.push(ids) });
  mounted.update({ points: points(4), mode: 'orders', selectedGroupId: 'G1', selectedOrderId: 'O3' });
  await flush();
  map.queries.push([
    { properties: { orderId: 'O0', groupId: 'G0' } },
    { properties: { orderId: 'O1', groupId: 'G1' } },
    { properties: { orderId: 'O3', groupId: 'G0' } },
    { properties: { orderId: 'O1', groupId: 'G1' } },
  ]);
  map.fire('click', { point: { x: 50, y: 80 } });
  assert.deepEqual(picked, [['O3', 'O1', 'O0']]);
  assert.deepEqual(map.lastBox, [[38, 68], [62, 92]]);
  mounted.update({ mode: 'regions' });
  map.fire('click', { point: { x: 50, y: 80 } });
  assert.equal(picked.length, 1);
  mounted.destroy();
});

test('레이어 오류와 이미지 실패는 숨기지 않고 부분 자원을 정리한다', async () => {
  class EventErrorMap extends FakeMap {
    addLayer(layer) {
      if (layer.id === 'dispatch-regions-counts') { this.fire('error', { error: new Error('invalid count layer') }); return; }
      super.addLayer(layer);
    }
  }
  const map = new EventErrorMap();
  const errors = [];
  const mounted = mountDispatchMapLayers(map, { onError: error => errors.push(error) });
  await flush();
  assert.equal(errors[0]?.message, 'invalid count layer');
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.images.size, 0);
  mounted.destroy();

  globalThis.Image = class { set src(_value) { queueMicrotask(() => this.onerror?.()); } };
  const imageMap = new FakeMap();
  const imageErrors = [];
  const pending = mountDispatchMapLayers(imageMap, { onError: error => imageErrors.push(error) });
  await flush();
  assert.match(imageErrors[0]?.message, /마커 이미지/);
  assert.equal(imageMap.sources.size, 0);
  pending.destroy();
  globalThis.Image = FakeImage;
});

test('파괴 후 MapLibre 레이어와 소스를 남기지 않는다', async () => {
  const map = new FakeMap();
  const mounted = mountDispatchMapLayers(map);
  await flush();
  mounted.destroy();
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(map.images.size, 0);
});
